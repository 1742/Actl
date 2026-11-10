import { setTimeout as delay } from 'node:timers/promises';
import type { AgentInboxMessage, AgentTreeEvent, AgentTreeSnapshot, PlanItem } from '../../../shared/agent/coordination.js';
import type { AgentCoordinationRepository } from '../../repositories/agent-coordination-repository.js';
import type { ReasoningEffort } from '../../model/catalog-types.js';
import type { AgentStreamEvent } from '../../../shared/agent/responses.js';
import type { ProjectSettings } from '../../../shared/agent/sessions.js';
import { toSessionJson } from '../../contracts/common/presenters.js';
import { toAgentResponseDto } from '../../contracts/agent-responses/presenter.js';
import { createRandomId } from '../../utils.js';
import { isTerminalRun, type AgentDomainEventHandler, type AgentRunRecord, type PermissionResolution } from '../agent-domain.js';
import { AgentLoopError } from '../agent-loop/agent-loop-error.js';
import { ExecutionAdmission, ResponseScopeConflictError } from '../execution-admission.js';
import { SessionRuntime, mapSessionConcurrencyError, type AgentRunOptions, type PrepareRunInput, type SessionRuntimeServices } from '../session/session-runtime.js';
import type { Session, WorkspaceStore } from '../workspace-store.js';
import type { ProcessSupervisor } from '../process/process-supervisor.js';
import { AgentEventHub } from './agent-event-hub.js';

const MAX_ACTIVE_CHILDREN = 3;
const MAX_CHILDREN = 12;

export class AgentCoordinator {
  private readonly events: AgentEventHub;
  private readonly executions = new Set<Promise<unknown>>();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly admission: ExecutionAdmission;
  private readonly stops = new Map<string, Promise<void>>();
  private readonly stoppingTrees = new Set<string>();
  private readonly stoppedSessions = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;

  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly state: AgentCoordinationRepository,
    private readonly processes: ProcessSupervisor,
    private readonly services: SessionRuntimeServices,
  ) {
    this.events = new AgentEventHub(services.files);
    this.admission = new ExecutionAdmission(workspace);
  }

  async start(session: Session, prepareInput: PrepareRunInput, options: AgentRunOptions, listener?: (event: AgentStreamEvent) => void): Promise<AgentRunRecord> {
    const { running } = await this.serialized(session.rootSessionId ?? session.id, () => {
      this.assertSessionExists(session);
      this.allowUserTurn(session);
      return { running: this.begin(session, prepareInput, options, this.eventHandler(session, listener)) };
    });
    return running;
  }

  async resume(session: Session, run: AgentRunRecord, batchId: string, decisions: readonly PermissionResolution[], listener?: (event: AgentStreamEvent) => void): Promise<AgentRunRecord> {
    const { running } = await this.serialized(session.rootSessionId ?? session.id, () => {
      this.assertSessionExists(session);
      this.assertOpen(session);
      return { running: this.trackRun(session, this.runtime(session).resume(run, batchId, decisions, this.eventHandler(session, listener))) };
    });
    return running;
  }

  async compact(session: Session, model: string, reasoningEffort?: ReasoningEffort): Promise<boolean> {
    const { running } = await this.serialized(session.rootSessionId ?? session.id, () => {
      this.assertSessionExists(session);
      this.assertAvailableForUser(session);
      return { running: this.track(this.runtime(session).compact(model, reasoningEffort)) };
    });
    return running;
  }

  async updateProject(projectId: string, ownerId: string, settings: ProjectSettings) {
    return this.withProjectMaintenance(projectId, async () => {
      const active = await this.workspace.findActiveResponseInProject(ownerId, projectId);
      if (active) {
        throw new AgentLoopError('project_active_response_exists', 'Project already has an active response.', {
          sessionId: active.sessionId, responseId: active.id,
        });
      }
      return this.workspace.updateProject(ownerId, projectId, settings);
    });
  }

  async deleteProject(projectId: string, ownerId: string): Promise<void> {
    await this.withProjectMaintenance(projectId, async () => {
      const members = this.workspace.listSessions(ownerId, projectId);
      await Promise.all(members.filter((member) => !member.parentSessionId).map(async (member) => {
        const root = await this.workspace.getSession(member.id, ownerId);
        if (root) await this.stopTree(root);
      }));
      await this.workspace.deleteProject(ownerId, projectId);
      const runtimeIds = [...this.runtimes.values()]
        .filter(({ session }) => session.projectId === projectId && session.ownerId === ownerId)
        .map(({ session }) => session.id);
      this.forget([...members.map((member) => member.id), ...runtimeIds]);
    }, true);
  }

  async deleteSession(session: Session): Promise<void> {
    try {
      await this.admission.withSessionMaintenance(session.id, async () => {
        await this.stopTree(session);
        const ids = this.workspace.descendants(session.id).map((member) => member.id);
        await this.workspace.deleteSession(session.ownerId, session.id);
        this.forget(ids);
      });
    } catch (error) {
      throw mapSessionConcurrencyError(session, error);
    }
  }

  async cancelResponse(session: Session, run: AgentRunRecord): Promise<AgentRunRecord> {
    if (run.status === 'cancelled') return run;
    if (isTerminalRun(run)) throw new AgentLoopError('response_not_cancellable', 'Response is no longer active.');
    await this.stopTree(session);
    return run;
  }

  async recover(ownerId: string): Promise<void> {
    // Never auto-run paid/model work on app restart. Recover receipts for the next explicit turn.
    for (const metadata of this.workspace.listSessions(ownerId)) {
      if (!metadata.parentSessionId) continue;
      const session = await this.workspace.getSession(metadata.id, ownerId);
      if (!session) continue;
      for (const run of session.runs) if (isTerminalRun(run)) this.recordResult(session, run, false);
    }
  }

  subscribe(listener: (event: AgentTreeEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  activeToolCaller(sessionId: string, runId: string): { session: Session; run: AgentRunRecord } {
    const session = this.runtimes.get(sessionId)?.session;
    const run = session?.runs.find((item) => item.id === runId);
    if (!session || !run || run.status !== 'in_progress') throw new Error('Caller run is not active.');
    return { session, run };
  }

  async snapshot(session: Session): Promise<AgentTreeSnapshot> {
    const rootSessionId = session.rootSessionId ?? session.id;
    const members = [];
    for (const item of this.workspace.descendants(rootSessionId)) {
      const loaded = await this.workspace.getSession(item.id, session.ownerId);
      if (!loaded) continue;
      const run = loaded.runs.at(-1);
      members.push({ session: toSessionJson(loaded), ...(run ? {
        response: toAgentResponseDto(run, this.services.files.describeForSession.bind(this.services.files)),
        sequenceNumber: run.nextSequenceNumber - 1,
      } : {}) });
    }
    return { rootSessionId, members, plan: this.state.plan(rootSessionId) };
  }

  async list(session: Session) {
    const snapshot = await this.snapshot(session);
    return { rootSessionId: snapshot.rootSessionId, plan: snapshot.plan, agents: snapshot.members.map((member) => ({
      sessionId: member.session.id, parentSessionId: member.session.parentSessionId, title: member.session.title,
      runId: member.response?.id, status: member.response?.status ?? 'idle',
      output: this.resultText(this.workspace.listResponses(member.session.id).at(-1)),
    })) };
  }

  async spawn(parent: Session, run: AgentRunRecord, callId: string, title: string, prompt: string) {
    if (parent.parentSessionId) throw new Error('Nested delegation is disabled. Send findings to the parent agent.');
    const admitted = await this.serialized(parent.id, async () => {
      this.assertSessionExists(parent);
      this.assertOpen(parent);
      const children = this.workspace.descendants(parent.id).filter((item) => item.id !== parent.id);
      const existing = children.find((item) => item.originRunId === run.id && item.originCallId === callId);
      if (existing) return { existing };
      if (children.length >= MAX_CHILDREN) throw new Error(`At most ${MAX_CHILDREN} child sessions per chat. Continue an existing child instead.`);
      this.assertCapacity(parent);
      const child = await this.workspace.createSession(parent.ownerId, {
        ...(parent.projectId ? { projectId: parent.projectId } : {}), title,
        parentSessionId: parent.id, originRunId: run.id, originCallId: callId,
      });
      this.changed(parent.id);
      const started = new Promise<AgentRunRecord>((resolve, reject) => {
        void this.startFromRun(child, prompt, run, resolve).then(resolve, reject);
      });
      return { child, started };
    });
    if (admitted.existing) {
      return { sessionId: admitted.existing.id, status: admitted.existing.runs.at(-1)?.status ?? 'interrupted' };
    }
    const runStarted = await admitted.started;
    return { sessionId: admitted.child.id, runId: runStarted.id, status: runStarted.status };
  }

  async send(sender: Session, sourceRun: AgentRunRecord, targetId: string, text: string, callId: string, userFollowUp = false) {
    const target = await this.related(sender, targetId);
    return this.serialized(sender.rootSessionId ?? sender.id, () => {
      this.assertSessionExists(sender);
      this.assertSessionExists(target);
      if (userFollowUp) this.allowUserTurn(sender);
      this.assertOpen(sender);
      this.assertAvailableForUser(target);
      this.stoppedSessions.delete(target.id);
      const message: AgentInboxMessage = {
        id: createRandomId('agent_message'), fromSessionId: sender.id, toSessionId: target.id,
        sourceRunId: sourceRun.id, kind: 'message', text, wake: true,
      };
      this.state.enqueue(message, `message:${sourceRun.id}:${callId}`);
      this.scheduleWake(target.id);
      this.changed(sender.rootSessionId ?? sender.id);
      return { sessionId: target.id, accepted: true };
    });
  }

  async wait(parent: Session, ids: string[], timeoutMs: number, signal?: AbortSignal) {
    for (const id of ids) {
      const child = await this.related(parent, id);
      if (child.parentSessionId !== parent.id) throw new Error('Only direct children can be awaited.');
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const members = (await this.snapshot(parent)).members.filter((item) => ids.includes(item.session.id));
      if (members.some((item) => item.response?.status !== 'in_progress') || Date.now() >= deadline) {
        return members.map((item) => ({ sessionId: item.session.id, status: item.response?.status ?? 'idle',
          output: this.resultText(this.workspace.listResponses(item.session.id).at(-1)) }));
      }
      await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, signal ? { signal } : undefined);
    }
  }

  updatePlan(session: Session, revision: number, items: PlanItem[]) {
    if (session.parentSessionId) throw new Error('Only the root agent can update the plan.');
    const plan = this.state.updatePlan(session.id, revision, items);
    this.changed(session.id);
    return plan;
  }

  async interrupt(caller: Session, targetId: string): Promise<void> {
    const target = await this.related(caller, targetId);
    if (target.parentSessionId !== caller.id) throw new Error('Only a parent can interrupt its child.');
    await this.stopTree(target);
  }

  /** User cancellation is a tree boundary, including queued automatic wakes. */
  stopTree(session: Session): Promise<void> {
    const existing = this.stops.get(session.id);
    if (existing) return existing;
    const root = session.rootSessionId ?? session.id;
    if (session.id === root) this.stoppingTrees.add(root);
    this.stoppedSessions.add(session.id);
    const stopping = this.stopMembers(session, root).finally(() => { this.stops.delete(session.id); });
    this.stops.set(session.id, stopping);
    return stopping;
  }

  private async stopMembers(session: Session, root: string): Promise<void> {
    const members = await this.serialized(root, () => {
      const descendants = this.workspace.descendants(session.id);
      for (const member of descendants) {
        this.stoppedSessions.add(member.id);
        this.state.suppressWake(member.id);
        const timer = this.wakeTimers.get(member.id);
        if (timer) clearTimeout(timer);
        this.wakeTimers.delete(member.id);
      }
      return descendants;
    });
    const stopped = await Promise.allSettled(members.map(async (member) => {
      const loaded = await this.workspace.getSession(member.id, session.ownerId);
      if (loaded) await this.runtime(loaded).stop();
    }));
    this.changed(root);
    this.scheduleTree(root);
    const failure = stopped.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async close(drain?: () => Promise<void>): Promise<void> {
    this.closing = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    try {
      const stops = await Promise.allSettled([...this.runtimes.values()].map((runtime) => runtime.stop(true)));
      await Promise.allSettled([...this.executions, ...this.stops.values()]);
      await drain?.();
      const failure = stops.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      await this.processes.dispose();
      this.runtimes.clear();
    }
  }

  private runtime(session: Session): SessionRuntime {
    let runtime = this.runtimes.get(session.id);
    if (!runtime) {
      runtime = new SessionRuntime(
        session, this.workspace, this.state, this.admission,
        this.processes.forSession(session.id), this.services, this.eventHandler(session),
      );
      this.runtimes.set(session.id, runtime);
    }
    return runtime;
  }

  private eventHandler(session: Session, listener?: (event: AgentStreamEvent) => void, onCreated?: (run: AgentRunRecord) => void): AgentDomainEventHandler {
    const rootSessionId = session.rootSessionId ?? session.id;
    return (run, event) => {
      const terminal = event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled' || event.type === 'run_incomplete';
      if (terminal && session.parentSessionId) {
        this.recordResult(session, run, !this.closing && !this.stoppedSessions.has(session.id) && !this.stoppingTrees.has(rootSessionId));
      }
      const events = this.events.project(run, event);
      this.events.publish({ type: 'response', rootSessionId, sessionId: session.id, events });
      if (terminal || event.type === 'run_created' || event.type === 'permissions_requested') this.changed(rootSessionId);
      if (event.type === 'run_created') onCreated?.(run);
      if (listener) {
        for (const item of events) {
          try { listener(structuredClone(item)); } catch { /* A subscriber cannot fail an agent run. */ }
        }
      }
    };
  }

  private begin(session: Session, prepareInput: PrepareRunInput, options: AgentRunOptions, onEvent: AgentDomainEventHandler): Promise<AgentRunRecord> {
    this.assertOpen(session);
    return this.trackRun(session, this.runtime(session).start(prepareInput, options, onEvent));
  }

  private startFromRun(session: Session, prompt: string, sourceRun: AgentRunRecord, onCreated?: (run: AgentRunRecord) => void): Promise<AgentRunRecord> {
    return this.begin(session, async () => [{
      id: createRandomId('msg'), type: 'message', role: 'user', content: [{ type: 'text', text: prompt }],
    }], {
      model: sourceRun.modelSnapshot.targetId,
      ...(sourceRun.modelSnapshot.reasoningEffort ? { reasoningEffort: sourceRun.modelSnapshot.reasoningEffort } : {}),
      permissionMode: sourceRun.permissionSnapshot.permissionMode,
    }, this.eventHandler(session, undefined, onCreated));
  }

  private trackRun(session: Session, operation: Promise<AgentRunRecord>): Promise<AgentRunRecord> {
    return this.track(operation.then((run) => {
      // Wait for the execution lease to be released before waking an idle session.
      if (isTerminalRun(run)) this.scheduleTree(session.rootSessionId ?? session.id);
      return run;
    }));
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.executions.add(operation);
    void operation.finally(() => { this.executions.delete(operation); }).catch(() => undefined);
    return operation;
  }

  private scheduleTree(root: string): void {
    if (this.closing || this.stoppingTrees.has(root)) return;
    for (const member of this.workspace.descendants(root)) this.scheduleWake(member.id);
  }

  private scheduleWake(sessionId: string): void {
    if (this.closing || this.stoppedSessions.has(sessionId) || this.wakeTimers.has(sessionId) ||
      !this.state.pending(sessionId).some((message) => message.wake)) return;
    const timer = setTimeout(() => {
      this.wakeTimers.delete(sessionId);
      // Failed automatic starts leave durable input for explicit continuation.
      void this.track(this.wake(sessionId));
    }, 0);
    this.wakeTimers.set(sessionId, timer);
  }

  private async wake(id: string): Promise<void> {
    const session = await this.workspace.getSession(id);
    if (!session) return;
    const root = session.rootSessionId ?? session.id;
    await this.serialized(root, () => {
      if (!this.workspace.hasSession(id, session.ownerId)) return;
      if (this.closing || this.stoppingTrees.has(root) || this.stoppedSessions.has(id) || this.runtimes.get(id)?.preparing) return;
      if (!this.state.pending(id).some((message) => message.wake)) return;
      if (session.runs.some((run) => !isTerminalRun(run))) return;
      const previous = session.runs.at(-1);
      if (!previous) return;
      if (session.parentSessionId) this.assertCapacity(session);
      void this.startFromRun(session, 'Continue with the queued agent messages. Reconcile the plan and report the result.', previous);
    });
  }

  private async related(sender: Session, targetId: string): Promise<Session> {
    const target = await this.workspace.getSession(targetId, sender.ownerId);
    if (!target || (target.rootSessionId ?? target.id) !== (sender.rootSessionId ?? sender.id) ||
      (target.parentSessionId !== sender.id && sender.parentSessionId !== target.id)) throw new Error('Target must be a parent or direct child in this agent tree.');
    return target;
  }
  private assertSessionExists(session: Session): void {
    if (!this.workspace.hasSession(session.id, session.ownerId)) throw new Error('Agent session no longer exists.');
  }

  private assertAvailableForUser(session: Session): void {
    if (this.closing || this.stops.has(session.id) || this.stops.has(session.rootSessionId ?? session.id)) {
      throw new Error('Agent tree is stopping.');
    }
  }

  private allowUserTurn(session: Session): void {
    this.assertAvailableForUser(session);
    this.stoppingTrees.delete(session.rootSessionId ?? session.id);
    this.stoppedSessions.delete(session.id);
  }

  private forget(ids: string[]): void {
    for (const id of ids) {
      this.runtimes.delete(id);
      this.stoppedSessions.delete(id);
      this.stoppingTrees.delete(id);
    }
  }

  private async withProjectMaintenance<T>(projectId: string, operation: () => Promise<T>, stopPreparing = false): Promise<T> {
    try { return await this.admission.withProjectMaintenance(projectId, operation, stopPreparing); }
    catch (error) {
      if (!(error instanceof ResponseScopeConflictError)) throw error;
      throw new AgentLoopError('project_active_response_exists', 'Project already has an active response.',
        error.holder && { sessionId: error.holder.sessionId, responseId: error.holder.responseId });
    }
  }

  private assertOpen(session: Session): void {
    if (this.closing || this.stoppingTrees.has(session.rootSessionId ?? session.id) || this.stoppedSessions.has(session.id)) throw new Error('Agent tree is stopping.');
  }
  private recordResult(session: Session, run: AgentRunRecord, wake: boolean): void {
    if (!session.parentSessionId) return;
    this.state.enqueue({ id: createRandomId('agent_result'), fromSessionId: session.id,
      toSessionId: session.parentSessionId, sourceRunId: run.id, kind: 'result',
      text: `Status: ${run.status}\n${this.resultText(run)}`, wake,
    }, `result:${run.id}`);
  }
  private assertCapacity(session: Session): void {
    const root = session.rootSessionId ?? session.id;
    const active = this.workspace.descendants(root).filter((item) => item.parentSessionId &&
      (this.runtimes.get(item.id)?.preparing || item.runs.some((run) => !isTerminalRun(run))));
    if (active.length >= MAX_ACTIVE_CHILDREN) throw new Error(`At most ${MAX_ACTIVE_CHILDREN} child agents can be active. Wait for one to finish.`);
  }
  private resultText(run?: AgentRunRecord): string {
    if (!run) return '';
    const last = run.timeline.findLast((item) => item.type === 'message' && item.role === 'assistant');
    const text = last?.type === 'message' ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') : '';
    return [text.slice(0, 16000), run.error?.message].filter(Boolean).join('\n');
  }
  private changed(rootSessionId: string): void { this.events.publish({ type: 'changed', rootSessionId }); }
  private serialized<T>(root: string, operation: () => T | Promise<T>): Promise<T> {
    const result = (this.queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(root, tail);
    void tail.then(() => { if (this.queues.get(root) === tail) this.queues.delete(root); });
    return result;
  }
}
