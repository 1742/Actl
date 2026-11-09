import { setTimeout as delay } from 'node:timers/promises';
import type { AgentInboxMessage, AgentTreeSnapshot, PlanItem } from '../../../shared/agent/coordination.js';
import type { AgentCoordinationStore } from '../../repositories/sqlite/agent-coordination-store.js';
import type { StoredFileService } from '../../stored-files/stored-file-service.js';
import { toSessionJson } from '../../contracts/common/presenters.js';
import { toAgentResponseDto } from '../../contracts/agent-responses/presenter.js';
import { createRandomId } from '../../utils.js';
import type { AgentDomainEventHandler, AgentRunRecord } from '../agent-domain.js';
import type { AgentLoop, AgentRuntimeSupport, AgentRunOptions } from '../agent-loop/agent-loop.js';
import type { Session, WorkspaceStore } from '../workspace-store.js';
import type { ProcessSupervisor } from '../process/process-supervisor.js';
import { AgentEventHub, isTerminal } from './agent-event-hub.js';

const MAX_ACTIVE_CHILDREN = 3;
const MAX_CHILDREN = 12;

export class AgentCoordinator implements AgentRuntimeSupport {
  readonly events: AgentEventHub;
  private readonly executions = new Set<Promise<unknown>>();
  private readonly starting = new Set<string>();
  private readonly stoppingTrees = new Set<string>();
  private readonly stoppedSessions = new Set<string>();
  private readonly suppressedRuns = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  private closing = false;

  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly state: AgentCoordinationStore,
    private readonly loop: AgentLoop,
    private readonly files: StoredFileService,
    private readonly processes: ProcessSupervisor,
  ) { this.events = new AgentEventHub(files); }

  async recover(ownerId: string): Promise<void> {
    // Never auto-run paid/model work on app restart. Recover receipts for the next explicit turn.
    for (const metadata of this.workspace.listSessions(ownerId)) {
      if (!metadata.parentSessionId) continue;
      const session = await this.workspace.getSession(metadata.id, ownerId);
      if (!session) continue;
      for (const run of session.runs) if (isTerminal(run)) this.recordResult(session, run, false);
    }
  }

  async snapshot(session: Session): Promise<AgentTreeSnapshot> {
    const rootSessionId = session.rootSessionId ?? session.id;
    const members = [];
    for (const item of this.workspace.descendants(rootSessionId)) {
      const loaded = await this.workspace.getSession(item.id, session.ownerId);
      if (!loaded) continue;
      const run = loaded.runs.at(-1);
      members.push({ session: toSessionJson(loaded), ...(run ? {
        response: toAgentResponseDto(run, this.files.describeForSession.bind(this.files)),
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
    return this.serialized(parent.id, async () => {
      this.assertOpen(parent);
      const children = this.workspace.descendants(parent.id).filter((item) => item.id !== parent.id);
      const existing = children.find((item) => item.originRunId === run.id && item.originCallId === callId);
      if (existing) return { sessionId: existing.id, status: existing.runs.at(-1)?.status ?? 'interrupted' };
      if (children.length >= MAX_CHILDREN) throw new Error(`At most ${MAX_CHILDREN} child sessions per chat. Continue an existing child instead.`);
      this.assertCapacity(parent);
      const child = await this.workspace.createSession(parent.ownerId, {
        ...(parent.projectId ? { projectId: parent.projectId } : {}), title,
        parentSessionId: parent.id, originRunId: run.id, originCallId: callId,
      });
      this.changed(parent.id);
      return this.launch(child, prompt, run);
    });
  }

  async send(sender: Session, sourceRun: AgentRunRecord, targetId: string, text: string, callId: string) {
    const target = await this.related(sender, targetId);
    this.assertOpen(sender);
    this.stoppedSessions.delete(target.id);
    if (target.id === sender.id) throw new Error('Cannot send a message to yourself.');
    const message: AgentInboxMessage = {
      id: createRandomId('agent_message'), fromSessionId: sender.id, toSessionId: target.id,
      sourceRunId: sourceRun.id, kind: 'message', text, wake: true,
    };
    this.state.enqueue(message, `message:${sourceRun.id}:${callId}`);
    this.scheduleWake(target.id);
    this.changed(sender.rootSessionId ?? sender.id);
    return { sessionId: target.id, accepted: true };
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
  async stopTree(session: Session): Promise<void> {
    const root = session.rootSessionId ?? session.id;
    if (session.id === root) this.stoppingTrees.add(root);
    this.stoppedSessions.add(session.id);
    // Drain spawn admission before enumerating descendants; prevents cancellation/start races.
    await this.serialized(root, async () => undefined);
    const descendants = this.workspace.descendants(session.id);
    for (const member of descendants) {
      this.stoppedSessions.add(member.id);
      this.state.suppressWake(member.id);
      const timer = this.wakeTimers.get(member.id);
      if (timer) clearTimeout(timer);
      this.wakeTimers.delete(member.id);
      for (const run of member.runs) if (!isTerminal(run)) this.suppressedRuns.add(run.id);
    }
    await Promise.all(descendants.map(async (member) => {
      await this.loop.cancelBySession(member.id);
      await this.processes.stopByOwner({ type: 'session', id: member.id });
    }));
    this.changed(root);
  }

  allowUserTurn(session: Session): void {
    this.stoppingTrees.delete(session.rootSessionId ?? session.id);
    this.stoppedSessions.delete(session.id);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    await this.loop.cancelRunning();
    await Promise.allSettled([...this.executions]);
  }

  hasPending(session: Session): boolean { return this.state.pending(session.id).length > 0; }

  async beforeStep(session: Session, run: AgentRunRecord, onEvent?: AgentDomainEventHandler): Promise<void> {
    for (const message of this.state.pending(session.id)) {
      // A crash between transcript commit and acknowledgement must not duplicate delivery.
      const alreadyDelivered = session.runs.some((item) => item.input.some((input) => input.id === message.id) || item.timeline.some((entry) => entry.id === message.id));
      if (!alreadyDelivered) {
        const item = { id: message.id, type: 'message' as const, role: 'user' as const, content: [{ type: 'text' as const,
          text: `[${message.kind === 'result' ? 'Runtime child result' : 'Agent message'} from ${message.fromSessionId}; source run ${message.sourceRunId}]\n${message.text}` }] };
        const outputIndex = run.timeline.push(item) - 1;
        await this.workspace.touch(session, run);
        await onEvent?.(run, { type: 'item_started', item, outputIndex });
        await onEvent?.(run, { type: 'item_completed', item, outputIndex });
      }
      this.state.acknowledge(message.id);
    }
  }

  onEvent: AgentDomainEventHandler = async (run, event) => {
    const session = await this.workspace.getSession(run.sessionId);
    if (!session) return;
    const rootSessionId = session.rootSessionId ?? session.id;
    this.events.publish({ type: 'response', rootSessionId, sessionId: session.id, events: this.events.project(run, event) });
    if (event.type === 'run_created' || event.type === 'permissions_requested') this.changed(rootSessionId);
    if (!['run_completed', 'run_failed', 'run_cancelled', 'run_incomplete'].includes(event.type)) return;
    this.changed(rootSessionId);
    if (session.parentSessionId) {
      this.recordResult(session, run, !this.suppressedRuns.has(run.id) && !this.stoppingTrees.has(rootSessionId) && !this.closing);
      if (!this.suppressedRuns.has(run.id)) this.scheduleWake(session.parentSessionId);
    }
    this.suppressedRuns.delete(run.id);
    for (const member of this.workspace.descendants(rootSessionId)) this.scheduleWake(member.id);
  };

  private async launch(session: Session, prompt: string, sourceRun: AgentRunRecord) {
    this.assertOpen(session);
    this.starting.add(session.id);
    let accept!: (run: AgentRunRecord) => void;
    let reject!: (error: unknown) => void;
    const started = new Promise<AgentRunRecord>((resolve, fail) => { accept = resolve; reject = fail; });
    const options: AgentRunOptions = { model: sourceRun.modelSnapshot.targetId,
      ...(sourceRun.modelSnapshot.reasoningEffort ? { reasoningEffort: sourceRun.modelSnapshot.reasoningEffort } : {}),
      permissionMode: session.parentSessionId ? 'plan' : sourceRun.permissionSnapshot.permissionMode };
    const executing = this.loop.run(session, async () => [{ id: createRandomId('msg'), type: 'message', role: 'user',
      content: [{ type: 'text', text: prompt }] }], options, (run, event) => { if (event.type === 'run_created') accept(run); });
    this.executions.add(executing);
    void executing.then(accept, reject).finally(() => {
      this.executions.delete(executing); this.starting.delete(session.id);
      this.scheduleWake(session.id);
    }).catch(() => undefined);
    try {
      const run = await started;
      return { sessionId: session.id, runId: run.id, status: run.status };
    } finally { this.starting.delete(session.id); }
  }

  private scheduleWake(sessionId: string): void {
    if (this.closing || this.wakeTimers.has(sessionId) || !this.state.pending(sessionId).some((message) => message.wake)) return;
    const timer = setTimeout(() => {
      this.wakeTimers.delete(sessionId);
      const operation = this.wake(sessionId);
      this.executions.add(operation);
      void operation.catch(() => { /* Pending durable input remains visible for explicit continuation. */ })
        .finally(() => this.executions.delete(operation));
    }, 0);
    this.wakeTimers.set(sessionId, timer);
  }

  private async wake(id: string): Promise<void> {
    const session = await this.workspace.getSession(id);
    if (!session) return;
    const root = session.rootSessionId ?? session.id;
    await this.serialized(root, async () => {
      if (this.closing || this.stoppingTrees.has(root) || this.stoppedSessions.has(id) || this.starting.has(id)) return;
      if (!this.state.pending(id).some((message) => message.wake)) return;
      if (session.runs.some((run) => !isTerminal(run))) return;
      const previous = session.runs.at(-1);
      if (!previous) return;
      if (session.parentSessionId) this.assertCapacity(session);
      await this.launch(session, 'Continue with the queued agent messages. Reconcile the plan and report the result.', previous);
    });
  }

  private async related(sender: Session, targetId: string): Promise<Session> {
    const target = await this.workspace.getSession(targetId, sender.ownerId);
    if (!target || (target.rootSessionId ?? target.id) !== (sender.rootSessionId ?? sender.id) ||
      (target.parentSessionId !== sender.id && sender.parentSessionId !== target.id)) throw new Error('Target must be a parent or direct child in this agent tree.');
    return target;
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
      (this.starting.has(item.id) || item.runs.some((run) => !isTerminal(run))));
    if (active.length >= MAX_ACTIVE_CHILDREN) throw new Error(`At most ${MAX_ACTIVE_CHILDREN} child agents can be active. Wait for one to finish.`);
  }
  private resultText(run?: AgentRunRecord): string {
    if (!run) return '';
    const last = run.timeline.findLast((item) => item.type === 'message' && item.role === 'assistant');
    const text = last?.type === 'message' ? last.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') : '';
    return [text.slice(0, 16000), run.error?.message].filter(Boolean).join('\n');
  }
  private changed(rootSessionId: string): void { this.events.publish({ type: 'changed', rootSessionId }); }
  private serialized<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(root, tail);
    void tail.then(() => { if (this.queues.get(root) === tail) this.queues.delete(root); });
    return result;
  }
}
