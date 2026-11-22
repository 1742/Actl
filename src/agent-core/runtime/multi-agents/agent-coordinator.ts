import { AgentDirectory, directoryState } from './agent-directory.js';
import { AgentMailbox, type SendMailInput } from './agent-mailbox.js';
import { WaitToolOutput } from '../transcript.js';
import type { AgentMail, AgentTask, AgentTaskInput, AgentTaskPendingReason, AgentTreeEvent, AgentTreeSnapshot, PlanItem, TaskAttempt } from '../../../shared/agent/coordination.js';
import type { AgentCoordinationRepository, AgentWait, RunActivation, TaskDecision, WaitCondition, WaitOutcome } from '../../repositories/agent-coordination-repository.js';
import { initialAgentRoleInput, reviewNotificationInput, taskAssignmentInput } from './coordination-input.js';
import { runAlias } from './coordination-references.js';
import { CoordinationWaits } from './coordination-waits.js';
import type { ReasoningEffort } from '../../model/catalog-types.js';
import type { AgentStreamEvent } from '../../../shared/agent/responses.js';
import type { ProjectSettings } from '../../../shared/agent/sessions.js';
import { toSessionJson } from '../../contracts/common/presenters.js';
import { toAgentResponseDto } from '../../contracts/agent-responses/presenter.js';
import { createRandomId } from '../../utils.js';
import { isTerminalRun, type AgentDomainEventHandler, type AgentRunRecord, type PermissionResolution } from '../agent-domain.js';
import { mailInput } from '../session/session-model-context.js';
import { AgentLoopError } from '../agent-loop/agent-loop-error.js';
import { ExecutionAdmission, ResponseScopeConflictError } from '../execution-admission.js';
import { SessionRuntime, mapSessionConcurrencyError, type AgentRunOptions, type PrepareRunInput, type SessionRuntimeServices } from '../session/session-runtime.js';
import type { Session, WorkspaceStore } from '../workspace-store.js';
import type { ProcessSupervisor } from '../process/process-supervisor.js';
import { AgentEventHub } from './agent-event-hub.js';
import { AgentProfileCatalog, DEFAULT_AGENT_PROFILE } from './agent-profile-catalog.js';
import { childPermissionMode } from './agent-tool-policy.js';
import { WorkspaceWrites } from '../workspace-writes.js';
import { childRunResults } from './child-run-results.js';

const MAX_ACTIVE_CHILDREN = 3;
const MAX_CHILDREN = 12;

function noIdleAgentMessage(role: string): string {
  return `No idle child agent with role "${role}" is available. Create one explicitly with delegate_task or wait for a matching child to become idle.`;
}

export type DelegationTarget = { kind: 'agent'; agent: string } | { kind: 'create'; role: string; name?: string | undefined };
export type WaitCommand =
  | { action: 'start'; condition: WaitCondition; timeoutMs: number }
  | { action: 'resume' }
  | { action: 'cancel' };

export class AgentCoordinator {
  readonly directory: AgentDirectory;
  readonly mailbox: AgentMailbox;
  private readonly events: AgentEventHub;
  private readonly waits: CoordinationWaits;
  private readonly retryTimer: NodeJS.Timeout;
  private dispatchTimer?: NodeJS.Timeout | undefined;
  private dispatching?: Promise<void> | undefined;
  private readonly executions = new Set<Promise<unknown>>();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly admission: ExecutionAdmission;
  private readonly writes = new WorkspaceWrites();
  private readonly stops = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<void>>();
  private closing = false;

  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly state: AgentCoordinationRepository,
    private readonly processes: ProcessSupervisor,
    private readonly services: SessionRuntimeServices,
    private readonly profiles = new AgentProfileCatalog(),
  ) {
    this.directory = new AgentDirectory(workspace, state);
    this.mailbox = new AgentMailbox(state, this.directory);
    this.events = new AgentEventHub(services.files);
    this.admission = new ExecutionAdmission(workspace);
    this.waits = new CoordinationWaits(state, workspace);
    this.retryTimer = setInterval(() => this.requestDispatch(), 500);
    this.retryTimer.unref();
    this.requestDispatch();
  }

  async start(session: Session, prepareInput: PrepareRunInput, options: AgentRunOptions, listener?: (event: AgentStreamEvent) => void): Promise<AgentRunRecord> {
    const { running } = await this.serialized(session.rootSessionId ?? session.id, async () => {
      this.assertSessionExists(session);
      if (session.parentSessionId) {
        throw new AgentLoopError('child_session_read_only', 'Send messages in the parent conversation.');
      }
      this.assertAvailableForUser(session);
      this.state.enableAgent(session.id);
      const wake = this.prepareWake(session, this.state.activeTask(session.id, session.id), true);
      const input: PrepareRunInput = async (signal) => [...(wake?.input ?? []), ...await prepareInput(signal)];
      return { running: this.begin(session, input, options, this.eventHandler(session, listener), wake?.activation) };
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
      if (session.parentSessionId) throw new Error('Child context is managed by its delegated runs.');
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
    const sessions = await this.directory.members(rootSessionId, session.ownerId);
    const members = sessions.map((member) => {
      const run = member.runs.at(-1);
      return {
        session: toSessionJson(member),
        waiting: directoryState(this.state, member) === 'waiting',
        ...(run ? {
          response: toAgentResponseDto(run, this.services.files.describeForSession.bind(this.services.files)),
          sequenceNumber: run.nextSequenceNumber - 1,
        } : {}),
      };
    });
    return {
      rootSessionId, members, plan: this.state.plan(rootSessionId), tasks: this.state.tasks(rootSessionId).map((task) => {
        const pendingReason = this.pendingTaskReason(task);
        return pendingReason ? { ...task, pendingReason } : task;
      }),
      childRunResults: sessions.length > 1 ? childRunResults(sessions, this.state.taskSourceRuns(rootSessionId)) : [],
    };
  }

  async listProfiles(session: Session) {
    this.assertRoot(session);
    return (await this.profiles.list()).map(({ id, name, description, access }) => ({ id, name, description, access }));
  }

  tasks(session: Session) {
    this.assertSessionExists(session);
    return this.state.tasks(session.rootSessionId ?? session.id).map((task) => this.presentTask(session, task));
  }

  taskDetails(session: Session, ref?: string) {
    const task = ref === undefined ? this.state.activeTask(session.rootSessionId ?? session.id, session.id) : this.requireTask(session, ref);
    if (!task) throw new Error('You have no active task. Use tasks list and pass a task reference to show.');
    const attempts = this.state.attemptHistory(task.rootSessionId, task.id).map((attempt) => this.presentAttempt(session, attempt));
    return { ...this.presentTask(session, task), attempts };
  }

  createTask(session: Session, run: AgentRunRecord, callId: string, draft: AgentTaskInput) {
    this.assertRoot(session);
    return this.mutate(session, () => {
      const blockedBy = draft.blockedBy?.map((ref) => this.requireTask(session, ref).id);
      const task = this.state.createTask(session.id, session.id, { ...draft, blockedBy }, `task:${run.id}:${callId}`);
      return this.presentTask(session, task);
    });
  }

  claimTask(session: Session, run: AgentRunRecord, callId: string, ref: string) {
    return this.mutate(session, () => {
      const task = this.requireTask(session, ref);
      this.assertMatches(session, task);
      if (this.state.wait(session.id)) throw new Error('Resolve or cancel your current wait before claiming a task.');
      if (task.reviewerSessionId === session.id) throw new Error('The reviewer cannot claim this task. Do your own work directly.');
      const claimed = this.state.assignTask(task.rootSessionId, task.id, session.id, { kind: 'claim', runId: run.id }, `claim:${run.id}:${callId}`);
      return this.presentTask(session, claimed);
    });
  }

  async delegateTask(parent: Session, run: AgentRunRecord, callId: string, ref: string, target?: DelegationTarget) {
    this.assertRoot(parent);
    return this.mutate(parent, async () => {
      const task = this.requireTask(parent, ref);
      const operation = `delegate:${run.id}:${callId}`;
      const existing = this.state.assignmentOwner(operation, task.id);
      if (existing) return this.presentTask(parent, task);
      if (!task.ready) throw new Error('Only a pending task with accepted dependencies can be delegated.');
      let child: Session | undefined;
      let created = false;
      if (!target) {
        child = (await this.idleChildren(parent)).find((agent) => this.matches(agent, task));
      } else if (target.kind === 'agent') {
        child = await this.directory.resolve(parent, target.agent);
        if (child.parentSessionId !== parent.id) throw new Error('Delegate to a child agent.');
        this.assertMatches(child, task);
        if (!this.isAvailable(child)) throw new Error('The selected agent is not idle.');
      } else {
        if (target.role !== task.type) throw new Error('The new role must match the task type.');
        child = await this.createChild(parent, run, callId, target);
        created = true;
      }
      if (!child) {
        this.state.requestAssignment(task.rootSessionId, task.id);
        return { ...this.presentTask(parent, { ...task, autoAssign: true }), reason: 'unassigned' };
      }
      try {
        const assigned = this.state.assignTask(parent.id, task.id, child.id, { kind: 'delegate', sourceRunId: run.id }, operation);
        return this.presentTask(parent, assigned);
      } catch (error) {
        if (created && !this.state.activeTask(parent.id, child.id)) await this.workspace.deleteSession(parent.ownerId, child.id);
        throw error;
      }
    });
  }

  async decideTask(session: Session, run: AgentRunRecord, callId: string, ref: string, decision: TaskDecision) {
    const { presented, stopped } = await this.mutate(session, () => {
      const task = this.requireTask(session, ref);
      const updated = this.state.decideTask(task.rootSessionId, task.id, session.id, decision, `decision:${run.id}:${callId}`);
      const cancellingRun = updated.status === 'cancelled' && task.status === 'running' && task.attempt;
      const stopped = cancellingRun ? this.runtimes.get(cancellingRun.ownerSessionId)?.stop() : undefined;
      return { presented: this.presentTask(session, updated), stopped };
    });
    await stopped;
    return presented;
  }

  plan(session: Session) {
    return this.state.plan(session.rootSessionId ?? session.id);
  }

  updatePlan(session: Session, revision: number, items: PlanItem[]) {
    this.assertRoot(session);
    const plan = this.state.updatePlan(session.id, revision, items);
    this.changed(session.id);
    return plan;
  }

  sendMail(session: Session, run: AgentRunRecord, callId: string, input: SendMailInput) {
    return this.mutate(session, () => this.mailbox.send(session, input, `mail:${run.id}:${callId}`));
  }

  async wait(session: Session, run: AgentRunRecord, callId: string, command: WaitCommand, signal?: AbortSignal) {
    const root = session.rootSessionId ?? session.id;
    const request = await this.serialized(root, async (): Promise<
      { kind: 'no_wait' } | { kind: 'cancel'; wait: AgentWait } | { kind: 'wait'; wait: AgentWait; ready?: WaitOutcome | undefined }
    > => {
      signal?.throwIfAborted();
      this.assertOpen(session);
      const current = this.state.wait(session.id);
      if (current && current.runId !== run.id) throw new Error('The wait belongs to another run.');
      if (command.action === 'cancel') return current ? { kind: 'cancel', wait: current } : { kind: 'no_wait' };
      if (command.action === 'resume') {
        if (!current) return { kind: 'no_wait' };
        this.state.resumeWait(current);
        this.changed(root);
        return { kind: 'wait', wait: current };
      }
      if (current) throw new Error('You have an existing wait. Use action resume to keep its deadline or cancel it explicitly.');
      const condition = await this.resolveCondition(session, command.condition);
      signal?.throwIfAborted();
      const deadline = Date.now() + command.timeoutMs;
      const draft = { rootId: root, sessionId: session.id, condition, cursor: this.state.eventCursor(), deadline, runId: run.id };
      const ready = await this.waits.outcome(draft, true);
      signal?.throwIfAborted();
      const wait = this.state.registerWait(draft);
      this.changed(root);
      return { kind: 'wait', wait, ready };
    });
    if (request.kind === 'no_wait') return { status: 'no_wait' };
    const wait = request.wait;
    if (request.kind === 'cancel') return new WaitToolOutput({ status: 'cancelled' }, { kind: 'settled', waitId: wait.id });

    const outcome = request.ready ?? await this.waits.until(wait, signal);
    if (outcome.kind === 'interrupted') {
      return new WaitToolOutput({
        status: 'interrupted', waitingFor: this.describeCondition(session, wait.condition), deadline: wait.deadline,
        messages: outcome.mail.map((mail) => this.mailbox.present(session, mail)),
      }, { kind: 'interrupted', waitId: wait.id, callId, mailIds: outcome.mail.map(({ id }) => id) });
    }
    return new WaitToolOutput(this.presentOutcome(session, outcome), {
      kind: 'settled', waitId: wait.id, ...(outcome.kind === 'mail' ? { mailIds: [outcome.message.id] } : {}),
    });
  }

  async interrupt(caller: Session, ref: string): Promise<void> {
    const target = await this.directory.resolve(caller, ref);
    if (target.parentSessionId !== caller.id) throw new Error('Only a parent can interrupt its child.');
    const root = caller.rootSessionId ?? caller.id;
    const { stopping } = await this.serialized(root, () => {
      this.assertOpen(caller);
      this.assertSessionExists(target);
      if (this.state.isRetired(target.id)) throw new Error('The child agent has been retired.');
      this.state.interruptAgent(root, target.id);
      return { stopping: this.runtime(target).stop() };
    });
    try {
      await stopping;
    } finally {
      this.changed(root);
    }
  }

  async retireChild(parent: Session, ref: string) {
    this.assertRoot(parent);
    const { target, stopping } = await this.mutate(parent, async () => {
      const target = await this.directory.resolve(parent, ref);
      if (target.parentSessionId !== parent.id) throw new Error('Only a parent can retire its child.');
      const runtime = this.runtimes.get(target.id);
      const status = directoryState(this.state, target);
      if (status === 'retired') return { target, stopping: runtime?.stop() };
      if ((status !== 'idle' && status !== 'stopped') || this.stops.has(target.id) || runtime?.isStopping || runtime?.preparing || runtime?.executing ||
        target.runs.some((run) => !isTerminalRun(run)) || this.state.activeTask(parent.id, target.id)) {
        throw new Error('Only an idle or stopped child with no active task can be retired.');
      }
      this.state.retireAgent(parent.id, target.id);
      return { target, stopping: runtime?.stop() };
    });
    await stopping;
    this.forget([target.id]);
    return { agent: this.directory.reference(parent, target.id), retired: true };
  }

  private async resolveCondition(session: Session, condition: WaitCondition): Promise<WaitCondition> {
    switch (condition.kind) {
      case 'mail': {
        const from = condition.from && (await this.directory.resolve(session, condition.from)).id;
        const original = condition.replyTo ? this.mailbox.requireMessage(session, condition.replyTo) : undefined;
        if (original && (original.fromSessionId !== session.id || (from && from !== original.toSessionId))) {
          throw new Error('Wait for a reply to mail you sent to that agent.');
        }
        return { kind: 'mail', from: original?.toSessionId ?? from, replyTo: original?.id, purpose: condition.purpose };
      }
      case 'task_state': return { ...condition, task: this.requireTask(session, condition.task).id };
      case 'agent_state': return { ...condition, agent: (await this.directory.resolve(session, condition.agent)).id };
      case 'run_finished': {
        const agent = await this.directory.resolve(session, condition.agent);
        const match = agent.runs.filter((run) => run.id === condition.run || runAlias(run.id) === condition.run);
        if (match.length !== 1) throw new Error('Choose an unambiguous run from that agent.');
        if (agent.id === session.id && !isTerminalRun(match[0]!)) throw new Error('A run cannot wait for itself to finish.');
        return { kind: condition.kind, agent: agent.id, run: match[0]!.id };
      }
    }
  }

  private assertRoot(session: Session): void {
    this.assertSessionExists(session);
    if (session.parentSessionId) throw new Error('Only the root agent can perform this operation.');
  }

  private mutate<T>(session: Session, action: () => T | Promise<T>): Promise<T> {
    const root = session.rootSessionId ?? session.id;
    return this.serialized(root, async () => {
      this.assertSessionExists(session);
      this.assertOpen(session);
      const result = await action();
      this.changed(root);
      return result;
    });
  }

  private requireTask(session: Session, ref: string): AgentTask {
    const root = session.rootSessionId ?? session.id;
    const number = /^#?([1-9][0-9]*)$/.exec(ref.trim().normalize('NFKC'))?.[1];
    const task = number ? this.state.tasks(root).find((item) => item.number === Number(number)) : this.state.task(root, ref);
    if (!task) throw new Error('Task not found in this conversation. Use tasks list for available references.');
    return task;
  }

  private presentTask(session: Session, task: AgentTask) {
    const pendingReason = this.pendingTaskReason(task);
    return {
      task: `#${task.number}`, title: task.title, type: task.type, status: task.status, ready: task.ready,
      instructions: task.instructions, acceptanceCriteria: task.acceptanceCriteria, autoAssign: task.autoAssign,
      blockedBy: this.state.tasks(task.rootSessionId).filter((item) => task.blockedBy.includes(item.id)).map((item) => `#${item.number}`),
      ...(pendingReason ? { pendingReason } : {}),
      ...(pendingReason === 'no_idle_agent' ? { message: noIdleAgentMessage(task.type) } : {}),
      reviewer: this.directory.reference(session, task.reviewerSessionId), ...(task.attempt ? { attempt: this.presentAttempt(session, task.attempt) } : {}),
    };
  }

  private pendingTaskReason(task: AgentTask): AgentTaskPendingReason | undefined {
    if (task.status !== 'pending') return undefined;
    if (!task.ready) return 'dependencies';
    if (task.autoAssign && !this.workspace.descendants(task.rootSessionId).some((member) =>
      member.parentSessionId === task.rootSessionId && this.matches(member, task) && this.isAvailable(member))) return 'no_idle_agent';
    return 'unassigned';
  }

  private presentAttempt(session: Session, attempt: TaskAttempt) {
    return {
      agent: this.directory.reference(session, attempt.ownerSessionId), outcome: attempt.outcome,
      startedAt: attempt.startedAt, reason: attempt.reason,
      ...(attempt.result ? { result: { run: runAlias(attempt.result.runId), output: attempt.result.output } } : {}),
    };
  }

  private presentOutcome(session: Session, outcome: WaitOutcome) {
    switch (outcome.kind) {
      case 'mail': return { status: 'matched', kind: outcome.kind, ...this.mailbox.present(session, outcome.message) };
      case 'task_state': return { status: 'matched', ...outcome, task: `#${this.requireTask(session, outcome.task).number}` };
      case 'agent_state': return { status: 'matched', ...outcome, agent: this.directory.reference(session, outcome.agent) };
      case 'run_finished': return { status: 'matched', ...outcome, run: runAlias(outcome.run) };
      case 'needs_agent': return { status: 'needs_agent', task: `#${this.requireTask(session, outcome.task).number}`, role: outcome.role,
        message: noIdleAgentMessage(outcome.role) };
      case 'timed_out': return { status: 'timed_out' };
    }
  }

  private describeCondition(session: Session, condition: WaitCondition) {
    switch (condition.kind) {
      case 'mail': return { ...condition, from: condition.from && this.directory.reference(session, condition.from),
        replyTo: condition.replyTo && `m#${this.state.mail(session.rootSessionId ?? session.id, condition.replyTo)?.number}` };
      case 'task_state': return { ...condition, task: `#${this.requireTask(session, condition.task).number}` };
      case 'agent_state': return { ...condition, agent: this.directory.reference(session, condition.agent) };
      case 'run_finished': return { ...condition, agent: this.directory.reference(session, condition.agent), run: runAlias(condition.run) };
    }
  }

  private matches(session: Session, task: AgentTask): boolean {
    return (session.profile ?? DEFAULT_AGENT_PROFILE).id === task.type;
  }

  private assertMatches(session: Session, task: AgentTask): void {
    if (!this.matches(session, task)) throw new Error('Agent role does not match this task type.');
  }

  private isAvailable(session: Session): boolean {
    const runtime = this.runtimes.get(session.id);
    return !this.stops.has(session.id) && !runtime?.isStopping && !runtime?.preparing && !runtime?.executing && directoryState(this.state, session) === 'idle' &&
      !this.state.activeTask(session.rootSessionId ?? session.id, session.id);
  }

  private async idleChildren(parent: Session): Promise<Session[]> {
    const idle = (await this.directory.members(parent.id, parent.ownerId))
      .filter((member) => member.parentSessionId === parent.id && this.isAvailable(member));
    const idleSince = (session: Session) => session.runs.at(-1)?.completedAt ?? session.created_at;
    return idle.sort((a, b) => idleSince(a).localeCompare(idleSince(b)) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  private async createChild(parent: Session, run: AgentRunRecord, callId: string, target: Extract<DelegationTarget, { kind: 'create' }>): Promise<Session> {
    const children = this.workspace.descendants(parent.id).filter((item) => item.parentSessionId === parent.id);
    const existing = children.find((item) => item.originRunId === run.id && item.originCallId === callId);
    if (existing) {
      if (this.state.isRetired(existing.id)) throw new Error('The child created by this delegation has been retired.');
      return (await this.workspace.getSession(existing.id, parent.ownerId))!;
    }
    if (children.filter((child) => !this.state.isRetired(child.id)).length >= MAX_CHILDREN) {
      throw new Error(`At most ${MAX_CHILDREN} non-retired child agents per conversation. Retire an idle child to free a slot.`);
    }
    const profile = await this.profiles.resolve(target.role);
    const { model, reasoningEffort } = this.childModel(run, profile);
    await this.services.models.resolveSnapshot(parent.ownerId, model, reasoningEffort);
    this.assertOpen(parent);
    return this.workspace.createSession(parent.ownerId, {
      ...(parent.projectId ? { projectId: parent.projectId } : {}), ...(target.name === undefined ? {} : { title: target.name }), profile,
      parentSessionId: parent.id, originRunId: run.id, originCallId: callId,
    });
  }

  /** User cancellation is a tree boundary, including queued automatic wakes. */
  stopTree(session: Session): Promise<void> {
    const existing = this.stops.get(session.id);
    if (existing) return existing;
    const root = session.rootSessionId ?? session.id;
    const stopping = this.stopMembers(session, root).finally(() => {
      this.stops.delete(session.id);
      this.changed(root);
    });
    this.stops.set(session.id, stopping);
    return stopping;
  }

  private async stopMembers(session: Session, root: string): Promise<void> {
    const members = await this.serialized(root, () => {
      const descendants = this.workspace.descendants(session.id);
      for (const member of descendants) this.state.stopAgent(root, member.id);
      return descendants;
    });
    const stopped = await Promise.allSettled(members.map(async (member) => {
      const loaded = await this.workspace.getSession(member.id, session.ownerId);
      if (loaded && !this.state.isRetired(member.id)) await this.runtime(loaded).stop();
    }));
    this.changed(root);
    const failure = stopped.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async close(drain?: () => Promise<void>): Promise<void> {
    this.closing = true;
    clearInterval(this.retryTimer);
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    await this.dispatching;
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
        session, this.workspace, this.state, this.admission, this.writes,
        this.processes.forSession(session.id), this.services, this.eventHandler(session),
      );
      this.runtimes.set(session.id, runtime);
    }
    return runtime;
  }

  private eventHandler(session: Session, listener?: (event: AgentStreamEvent) => void): AgentDomainEventHandler {
    const rootSessionId = session.rootSessionId ?? session.id;
    return (run, event) => {
      const terminal = event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_cancelled' || event.type === 'run_incomplete';
      const events = this.events.project(run, event);
      this.events.publish({ type: 'response', rootSessionId, sessionId: session.id, events });
      if (terminal || event.type === 'run_created' || event.type === 'permissions_requested' || event.type === 'permissions_resolved') this.changed(rootSessionId);
      if (listener) {
        for (const item of events) {
          try { listener(structuredClone(item)); } catch { /* A subscriber cannot fail an agent run. */ }
        }
      }
    };
  }

  private begin(session: Session, prepareInput: PrepareRunInput, options: AgentRunOptions, onEvent: AgentDomainEventHandler, activation?: RunActivation): Promise<AgentRunRecord> {
    this.assertOpen(session);
    return this.trackRun(session, this.runtime(session).start(prepareInput, options, onEvent, activation));
  }

  private childModel(sourceRun: AgentRunRecord, profile: Session['profile']): Pick<AgentRunOptions, 'model' | 'reasoningEffort'> {
    const model = profile?.modelTargetId ?? sourceRun.modelSnapshot.targetId;
    const effort = profile?.reasoningEffort ?? (model === sourceRun.modelSnapshot.targetId ? sourceRun.modelSnapshot.reasoningEffort : undefined);
    return { model, ...(effort ? { reasoningEffort: effort } : {}) };
  }

  private trackRun(session: Session, operation: Promise<AgentRunRecord>): Promise<AgentRunRecord> {
    return this.track(operation.finally(() => this.changed(session.rootSessionId ?? session.id)));
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.executions.add(operation);
    void operation.finally(() => { this.executions.delete(operation); }).catch(() => undefined);
    return operation;
  }

  private async dispatch(): Promise<void> {
    if (this.closing) return;
    const roots = new Set(this.state.rootsWithWork());
    for (const event of this.state.pendingEvents()) {
      try {
        if (event.kind === 'run_finished') this.state.finishRun(event.runId);
        this.state.dispatchEvent(event.id);
        this.waits.notify(event.rootId);
        roots.add(event.rootId);
        this.events.publish({ type: 'changed', rootSessionId: event.rootId });
      } catch (error) {
        this.logDispatchError(error, event.rootId);
      }
    }
    for (const rootId of roots) {
      if (this.closing) return;
      try {
        await this.serialized(rootId, () => this.reconcileRoot(rootId));
      } catch (error) {
        this.logDispatchError(error, rootId);
      }
    }
  }

  /** Refresh attempts, assign task. */
  private async reconcileRoot(rootId: string): Promise<void> {
    if (this.closing || this.stops.has(rootId) || this.state.isStopped(rootId)) return;
    const root = await this.workspace.getSession(rootId);
    if (!root) return;
    const expired = new Set(this.state.expiredAttempts(rootId, Date.now()));
    let available = await this.idleChildren(root);

    for (const task of this.state.tasks(rootId)) {
      if (!task.ready || !task.autoAssign) continue;
      const candidate = available.find((child) => this.matches(child, task));
      const source = root.runs.at(-1);
      if (!candidate || !source) continue;
      this.state.assignTask(rootId, task.id, candidate.id, { kind: 'delegate', sourceRunId: source.id }, createRandomId('auto'));
      available = available.filter((child) => child !== candidate);
    }

    for (const record of this.workspace.descendants(rootId)) {
      if (this.closing) return;
      const member = await this.workspace.getSession(record.id, root.ownerId);
      if (!member || this.stops.has(member.id) || this.state.isStopped(member.id)) continue;
      const task = this.state.activeTask(rootId, member.id);
      const runtime = this.runtimes.get(member.id);
      const active = runtime?.isStopping || runtime?.preparing || runtime?.executing || member.runs.some((run) => !isTerminalRun(run));

      if (task?.attempt) {
        if (active || task.status === 'assigned') {
          this.state.renewAttempt(task.attempt.id, Date.now());
        } else if (expired.has(task.attempt.id)) {
          this.state.failAttempt(task.attempt.id, 'The attempt lease expired before execution resumed.');
          continue;
        }
      }

      if (active || (member.parentSessionId && this.activeChildren(rootId) >= MAX_ACTIVE_CHILDREN)) continue;

      const wake = this.prepareWake(member, task);
      if (!wake) continue;
      const previous = await this.modelSource(member, task, wake.mail);
      if (!previous) {
        if (task?.attempt) this.state.failAttempt(task.attempt.id, 'No model context is available to start the task.');
        continue;
      }
      if (this.closing || this.stops.has(member.id) || this.stops.has(rootId)) continue;
      const parentMode = root.runs.at(-1)?.permissionSnapshot.permissionMode ?? 'plan';
      const sourceRunId = task?.attempt && this.state.taskSourceRun(task.attempt.id);
      const taskMode = sourceRunId ? root.runs.find((run) => run.id === sourceRunId)?.permissionSnapshot.permissionMode : undefined;
      const running = this.begin(member, async () => wake.input, {
        ...this.childModel(previous, member.profile),
        permissionMode: member.parentSessionId
          ? childPermissionMode(member, parentMode, taskMode)
          : previous.permissionSnapshot.permissionMode,
      }, this.eventHandler(member), wake.activation);
      void running.catch((error) => {
        // Admission conflicts are transient. The wake is still in durable storage.
        if (error instanceof AgentLoopError && ['active_response_exists', 'project_active_response_exists'].includes(error.code)) return;
        if (!this.closing && task?.attempt) this.state.failAttempt(task.attempt.id, error instanceof Error ? error.message : String(error));
        this.logDispatchError(error, rootId);
      });
    }
  }

  private prepareWake(session: Session, task: AgentTask | undefined, explicit = false) {
    const mail = this.state.pendingMail(session.id);
    const reviews = this.state.reviewNotifications(session.id);
    const hasUrgentMail = mail.some((item) => item.purpose === 'question' || item.purpose === 'urgent');
    if (!explicit && !hasUrgentMail && !reviews.length && task?.status !== 'assigned') return undefined;

    const input = mail.map((item) => mailInput(item, session, item.replyTo ? this.state.mail(item.rootId, item.replyTo)?.number : undefined));
    const role = initialAgentRoleInput(session);
    if (role) input.unshift(role);
    if (reviews.length) {
      input.push(reviewNotificationInput(reviews));
    }
    if (task?.status === 'assigned') {
      const previous = this.state.attemptHistory(task.rootSessionId, task.id).at(-2);
      input.push(taskAssignmentInput(session, task, previous));
    }
    const activation: RunActivation = {
      work: task?.attempt ? { kind: 'attempt', attemptId: task.attempt.id } : { kind: 'conversation' },
      mailIds: mail.map((item) => item.id), notificationIds: reviews.map((item) => item.eventId),
    };
    return { activation, input, mail };
  }

  private async modelSource(member: Session, task: AgentTask | undefined, mail: AgentMail[]): Promise<AgentRunRecord | undefined> {
    const prior = member.runs.at(-1);
    if (prior) return prior;
    if (task?.attempt) {
      const reviewer = await this.workspace.getSession(task.reviewerSessionId, member.ownerId);
      const source = reviewer?.runs.find((run) => run.id === this.state.taskSourceRun(task.attempt!.id));
      if (source) return source;
    }
    const sender = mail[0] && await this.workspace.getSession(mail[0].fromSessionId, member.ownerId);
    return sender?.runs.at(-1);
  }

  private activeChildren(rootId: string): number {
    return this.workspace.descendants(rootId).filter((member) => member.parentSessionId &&
      (this.runtimes.get(member.id)?.preparing || this.runtimes.get(member.id)?.executing ||
        member.runs.some((run) => !isTerminalRun(run)))).length;
  }

  private requestDispatch(): void {
    if (this.closing || this.dispatching || this.dispatchTimer) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      this.dispatching = this.dispatch().catch((error) => this.logDispatchError(error)).finally(() => { this.dispatching = undefined; });
    }, 0);
    this.dispatchTimer.unref();
  }

  private logDispatchError(error: unknown, rootId?: string): void {
    this.services.logger.error({ event: 'agent.coordination.dispatch_failed', rootId,
      message: error instanceof Error ? error.message : String(error) });
  }

  private assertSessionExists(session: Session): void {
    if (!this.workspace.hasSession(session.id, session.ownerId)) throw new Error('Agent session no longer exists.');
  }

  private assertAvailableForUser(session: Session): void {
    if (this.closing || this.stops.has(session.id) || this.stops.has(session.rootSessionId ?? session.id)) {
      throw new Error('Agent tree is stopping.');
    }
  }

  private forget(ids: string[]): void {
    for (const id of ids) this.runtimes.delete(id);
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
    this.assertAvailableForUser(session);
    if (this.state.isStopped(session.id) || this.state.isStopped(session.rootSessionId ?? session.id)) throw new Error('Agent is stopped.');
  }

  private changed(rootSessionId: string): void {
    this.waits.notify(rootSessionId);
    this.events.publish({ type: 'changed', rootSessionId });
    this.requestDispatch();
  }

  private serialized<T>(root: string, operation: () => T | Promise<T>): Promise<T> {
    const result = (this.queues.get(root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(root, tail);
    void tail.then(() => { if (this.queues.get(root) === tail) this.queues.delete(root); });
    return result;
  }
}
