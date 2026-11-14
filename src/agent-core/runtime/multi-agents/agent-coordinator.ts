import { EventEmitter, once } from 'node:events';
import type { AgentInboxMessage, AgentMessagePurpose, AgentTreeEvent, AgentTreeSnapshot, PlanItem } from '../../../shared/agent/coordination.js';
import type { AgentCoordinationRepository } from '../../repositories/agent-coordination-repository.js';
import type { ReasoningEffort } from '../../model/catalog-types.js';
import type { AgentStreamEvent } from '../../../shared/agent/responses.js';
import type { ProjectSettings } from '../../../shared/agent/sessions.js';
import { toSessionJson } from '../../contracts/common/presenters.js';
import { toAgentResponseDto } from '../../contracts/agent-responses/presenter.js';
import { createRandomId } from '../../utils.js';
import { isTerminalRun, type AgentDomainEventHandler, type AgentRunRecord, type AgentRunStatus, type PermissionResolution } from '../agent-domain.js';
import { instructionInput, instructionRun } from '../session/session-model-context.js';
import { AgentLoopError } from '../agent-loop/agent-loop-error.js';
import { ExecutionAdmission, ResponseScopeConflictError } from '../execution-admission.js';
import { SessionRuntime, mapSessionConcurrencyError, type AgentRunOptions, type PrepareRunInput, type SessionRuntimeServices } from '../session/session-runtime.js';
import type { Session, WorkspaceStore } from '../workspace-store.js';
import type { ProcessSupervisor } from '../process/process-supervisor.js';
import { AgentEventHub } from './agent-event-hub.js';

const MAX_ACTIVE_CHILDREN = 3;
const MAX_CHILDREN = 12;

type AgentWaitTarget = { sessionId: string; runId: string } | { sessionId: string; messageId: string };

interface WaitAgentsOptions {
  targets: AgentWaitTarget[];
  until: 'any' | 'all';
  timeoutMs: number;
}

interface ChildStatus {
  sessionId: string;
  status: AgentRunStatus | 'queued';
  runId?: string;
  messageId?: string;
  output?: string;
  error?: string;
}

interface SendAgentMessageOptions {
  userFollowUp?: boolean;
  purpose?: Exclude<AgentMessagePurpose, 'task'> | undefined;
  replyTo?: string | undefined;
}

export class AgentCoordinator {
  private readonly events: AgentEventHub;
  private readonly waitEvents = new EventEmitter();
  private readonly executions = new Set<Promise<unknown>>();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly admission: ExecutionAdmission;
  private readonly stops = new Map<string, Promise<void>>();
  private readonly stoppingTrees = new Set<string>();
  private readonly stoppedSessions = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private readonly childStarts = new Map<string, Promise<AgentRunRecord>>();
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
    const agents = [];
    for (const member of this.workspace.descendants(session.id)) {
      if (member.parentSessionId !== session.id) continue;
      const child = await this.workspace.getSession(member.id, session.ownerId);
      if (!child) continue;
      const run = child.runs.at(-1);
      agents.push({ sessionId: child.id, title: child.title, status: run?.status ?? 'idle', ...(run ? { runId: run.id } : {}) });
    }
    return { agents, plan: this.state.plan(session.rootSessionId ?? session.id) };
  }

  async spawn(parent: Session, run: AgentRunRecord, callId: string, title: string, prompt: string) {
    if (parent.parentSessionId) throw new Error('Nested delegation is disabled. Send findings to the parent agent.');
    const admitted = await this.serialized(parent.id, async () => {
      this.assertSessionExists(parent);
      this.assertOpen(parent);
      const children = this.workspace.descendants(parent.id).filter((item) => item.id !== parent.id);
      const match = children.find((item) => item.originRunId === run.id && item.originCallId === callId);
      const existing = match && await this.workspace.getSession(match.id, parent.ownerId);
      if (existing) {
        const first = existing.runs[0];
        if (first) return { started: Promise.resolve(first) };
        const started = this.childStarts.get(existing.id);
        if (started) return { started };
      } else if (children.length >= MAX_CHILDREN) {
        throw new Error(`At most ${MAX_CHILDREN} child sessions per chat. Continue an existing child instead.`);
      }
      this.assertCapacity(parent);
      const child = existing ?? await this.workspace.createSession(parent.ownerId, {
        ...(parent.projectId ? { projectId: parent.projectId } : {}), title,
        parentSessionId: parent.id, originRunId: run.id, originCallId: callId,
      });
      const taskKey = `task:${run.id}:${callId}`;
      let task = this.state.messageFromToolCall(taskKey);
      if (!task) {
        task = {
          id: createRandomId('agent_message'), fromSessionId: parent.id, toSessionId: child.id, sourceRunId: run.id,
          kind: 'message', text: prompt, wake: false, author: 'model', model: run.modelSnapshot.displayName,
          relationship: 'parent', purpose: 'task',
        };
        this.state.enqueue(task, taskKey);
      }
      const input = instructionInput(task);
      this.changed(parent.id);
      const started = new Promise<AgentRunRecord>((resolve, reject) => {
        void this.startWithInput(child, async () => [input], run, resolve).then(resolve, reject);
      });
      this.childStarts.set(child.id, started);
      const clearStart = () => { this.childStarts.delete(child.id); };
      void started.then(clearStart, clearStart);
      return { started };
    });
    const runStarted = await admitted.started;
    return { sessionId: runStarted.sessionId, runId: runStarted.id, status: runStarted.status };
  }

  async send(sender: Session, sourceRun: AgentRunRecord, targetId: string, text: string, callId: string, options: SendAgentMessageOptions = {}) {
    if (sourceRun.sessionId !== sender.id) throw new Error('Source run does not belong to the sending session.');
    const target = await this.related(sender, targetId);
    const downlink = target.parentSessionId === sender.id;
    if (options.userFollowUp && !downlink) throw new Error('User instructions can only be sent to a direct child.');
    return this.serialized(sender.rootSessionId ?? sender.id, () => {
      this.assertSessionExists(sender);
      this.assertSessionExists(target);
      const dedupeKey = `message:${sourceRun.id}:${callId}`;
      const existing = this.state.messageFromToolCall(dedupeKey);
      if (existing) {
        if (existing.toSessionId !== target.id) throw new Error('This tool call already sent a message to another session.');
        if (existing.wake) this.scheduleWake(target.id);
        return { sessionId: target.id, messageId: existing.id, accepted: true };
      }
      // Verify whether the message being replied to exists; for the message being replied to, the sender and recipient are the reverse of those in the reply message.
      if (options.replyTo && !this.state.getMessage(options.replyTo, target.id, sender.id)) {
        throw new Error('replyTo must identify a message received from the target agent.');
      }
      if (options.userFollowUp) this.allowUserTurn(sender);
      this.assertOpen(sender);
      this.assertAvailableForUser(target);
      if (downlink) this.stoppedSessions.delete(target.id);
      const message: AgentInboxMessage = {
        id: createRandomId('agent_message'), fromSessionId: sender.id, toSessionId: target.id,
        sourceRunId: sourceRun.id, kind: 'message', text, wake: downlink,
        author: options.userFollowUp ? 'user' : 'model',
        ...(options.userFollowUp ? {} : {
          model: sourceRun.modelSnapshot.displayName,
          relationship: downlink ? 'parent' : 'child',
          purpose: options.purpose ?? 'message',
          ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        }),
      };
      const messageId = this.state.enqueue(message, dedupeKey);
      if (message.wake) this.scheduleWake(target.id);
      this.changed(sender.rootSessionId ?? sender.id);
      return { sessionId: target.id, messageId, accepted: true };
    });
  }

  /** parent agent wait children */
  async wait(parent: Session, { targets, until, timeoutMs }: WaitAgentsOptions, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertSessionExists(parent);
    if (new Set(targets.map((target) => target.sessionId)).size !== targets.length) {
      throw new Error('Wait targets must specify distinct child sessions.');
    }
    const children = await Promise.all(targets.map(async (target) => {
      const child = await this.related(parent, target.sessionId);
      if (child.parentSessionId !== parent.id) throw new Error('Only direct children can be awaited.');
      if ('runId' in target) {
        const run = child.runs.find((item) => item.id === target.runId);
        if (!run) throw new Error('Run does not belong to the target child.');
        return { child, run };
      }
      if (!this.state.getMessage(target.messageId, parent.id, child.id)) {
        throw new Error('Message was not sent to the target child by this caller.');
      }
      return { child, messageId: target.messageId };
    }));

    return this.waitForChange(parent, timeoutMs, signal, () => {
      const pendingSessionIds: string[] = [];
      const needsInput: Array<{ sessionId: string; runId: string; messageId: string }> = [];
      const statuses = children.map(({ child, run: selected, messageId }): ChildStatus => {
        const sessionId = child.id;
        const target = { sessionId, ...(messageId ? { messageId } : {}) };
        const run = messageId ? instructionRun(child, messageId) : selected;
        if (!this.workspace.hasSession(sessionId, parent.ownerId)) {
          return { ...target, ...(run ? { runId: run.id } : {}), status: 'cancelled' };
        }

        // A child waiting for clarification can also prevent a new follow-up from being delivered.
        const active = child.runs.at(-1);
        const questionRun = run ?? (active?.status === 'in_progress' ? active : undefined);
        if (questionRun?.status === 'in_progress' || questionRun?.status === 'completed') {
          for (const question of this.state.unansweredClarifications(sessionId, parent.id, questionRun.id)) {
            needsInput.push({ sessionId, runId: questionRun.id, messageId: question.id });
          }
        }

        if (!run) {
          if (!messageId || !this.state.getMessage(messageId, parent.id, sessionId)?.wake) {
            return { ...target, status: 'cancelled' };
          }
          pendingSessionIds.push(sessionId);
          return { ...target, status: 'queued' };
        }

        const current = run === active;
        // The current run's terminal status is assigned before its final write and lease release.
        if (!isTerminalRun(run) || (current && (this.runtimes.get(sessionId)?.executing || this.stops.has(sessionId)))) {
          pendingSessionIds.push(sessionId);
          return { ...target, runId: run.id, status: isTerminalRun(run) ? 'in_progress' : run.status };
        }

        const output = run.status === 'completed' ? this.resultText(run) : '';
        return { ...target, runId: run.id, status: run.status,
          ...(output ? { output } : {}), ...(run.error ? { error: run.error.message } : {}) };
      });
      const finished = until === 'all' ? pendingSessionIds.length === 0 : pendingSessionIds.length < children.length;
      return { ready: needsInput.length > 0 || finished, value: { statuses, pendingSessionIds, needsInput } };
    });
  }

  async waitForMessage(session: Session, { sessionId, replyTo, timeoutMs }: {
    sessionId: string;
    replyTo?: string | undefined;
    timeoutMs: number;
  }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const peer = await this.related(session, sessionId);
    if (replyTo && !this.state.getMessage(replyTo, session.id, peer.id)) {
      throw new Error('replyTo must identify a message you sent to the target agent.');
    }
    return this.waitForChange<{ messageId?: string }>(session, timeoutMs, signal, () => {
      this.assertSessionExists(peer);
      const message = replyTo ? this.state.findReply(replyTo, peer.id, session.id) : this.state.pending(session.id)
        .find((item) => item.fromSessionId === peer.id && !instructionRun(session, item.id));
      return { ready: !!message, value: message ? { messageId: message.id } : {} };
    });
  }

  private async waitForChange<T extends object>(session: Session, timeoutMs: number, signal: AbortSignal | undefined, check: () => { ready: boolean; value: T }) {
    const root = session.rootSessionId ?? session.id;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const waitSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      for (;;) {
        signal?.throwIfAborted();
        this.assertSessionExists(session);
        const { ready, value } = check();
        if (ready) return { ...value, timedOut: false };
        if (timeoutMs === 0 || timeout.signal.aborted) return { ...value, timedOut: true };
        // Check and register the listener in the same turn so no notification is missed.
        try {
          await once(this.waitEvents, root, { signal: waitSignal });
        } catch (error) {
          signal?.throwIfAborted();
          if (!timeout.signal.aborted) throw error;
        }
      }
    } finally {
      clearTimeout(timer);
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
    const stopping = this.stopMembers(session, root).finally(() => {
      this.stops.delete(session.id);
      this.waitEvents.emit(root);
    });
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

  private startWithInput(session: Session, prepareInput: PrepareRunInput, sourceRun: AgentRunRecord, onCreated?: (run: AgentRunRecord) => void): Promise<AgentRunRecord> {
    return this.begin(session, prepareInput, {
      model: sourceRun.modelSnapshot.targetId,
      ...(sourceRun.modelSnapshot.reasoningEffort ? { reasoningEffort: sourceRun.modelSnapshot.reasoningEffort } : {}),
      permissionMode: sourceRun.permissionSnapshot.permissionMode,
    }, this.eventHandler(session, undefined, onCreated));
  }

  private trackRun(session: Session, operation: Promise<AgentRunRecord>): Promise<AgentRunRecord> {
    const root = session.rootSessionId ?? session.id;
    return this.track(operation.then((run) => {
      // Wait for the execution lease to be released before waking an idle session.
      if (isTerminalRun(run)) this.scheduleTree(root);
      return run;
    }).finally(() => { this.waitEvents.emit(root); }));
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
    if (!session?.parentSessionId) return;
    const root = session.rootSessionId ?? session.id;
    await this.serialized(root, async () => {
      if (!this.workspace.hasSession(id, session.ownerId)) return;
      if (this.closing || this.stoppingTrees.has(root) || this.stoppedSessions.has(id) || this.runtimes.get(id)?.preparing) return;
      const pending = this.state.pending(id);
      if (!pending.some((message) => message.wake)) return;
      if (session.runs.some((run) => !isTerminalRun(run))) return;
      let previous = session.runs.at(-1);
      const task = pending.find((message) => message.purpose === 'task');
      if (!previous && task) {
        const parent = await this.workspace.getSession(task.fromSessionId, session.ownerId);
        previous = parent?.runs.find((run) => run.id === task.sourceRunId);
      }
      if (!previous) return;
      const input = pending.flatMap((message) => {
        if (!instructionRun(session, message.id)) return [instructionInput(message)];
        this.state.acknowledge(message.id);
        return [];
      });
      if (!input.length) return;
      this.assertCapacity(session);
      void this.startWithInput(session, async () => input, previous);
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

  private assertCapacity(session: Session): void {
    const root = session.rootSessionId ?? session.id;
    const active = this.workspace.descendants(root).filter((item) => item.parentSessionId &&
      (this.runtimes.get(item.id)?.preparing || item.runs.some((run) => !isTerminalRun(run))));
    if (active.length >= MAX_ACTIVE_CHILDREN) throw new Error(`At most ${MAX_ACTIVE_CHILDREN} child agents can be active. Wait for one to finish.`);
  }

  private resultText(run: AgentRunRecord): string {
    const last = run.timeline.findLast((item) =>
      item.type === 'message' && item.role === 'assistant' && item.source?.kind !== 'runtime');
    const text = last?.type === 'message' ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') : '';
    return text.slice(0, 16000);
  }

  private changed(rootSessionId: string): void {
    this.waitEvents.emit(rootSessionId);
    this.events.publish({ type: 'changed', rootSessionId });
  }
  
  private serialized<T>(root: string, operation: () => T | Promise<T>): Promise<T> {
    const result = (this.queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(root, tail);
    void tail.then(() => { if (this.queues.get(root) === tail) this.queues.delete(root); });
    return result;
  }
}
