import { z } from 'zod';
import { agentMailPurposes, agentTaskStates } from '../../../shared/agent/coordination.js';
import { directoryStates } from '../../repositories/agent-coordination-repository.js';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';

const ref = z.string().trim().min(1).max(200);
const role = z.string().regex(/^[a-z][a-z0-9-]*$/).max(80);
const reason = z.string().trim().min(1).max(6000);
const empty = z.object({}).strict();
const tasks = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('show'), task: ref }).strict(),
  z.object({
    action: z.literal('publish'), title: z.string().trim().min(1).max(100),
    instructions: z.string().trim().min(1).max(20000), acceptanceCriteria: reason, type: role,
    blockedBy: z.array(ref).max(32).optional(), autoAssign: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal('claim'), task: ref }).strict(),
  z.object({ action: z.literal('accept'), task: ref }).strict(),
  z.object({ action: z.literal('reject'), task: ref, reason }).strict(),
  z.object({ action: z.literal('cancel'), task: ref, reason }).strict(),
  z.object({ action: z.literal('retry'), task: ref }).strict(),
]);
const delegate = z.object({ task: ref, target: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agent: ref }).strict(),
  z.object({ kind: z.literal('create'), role }).strict(),
]).optional() }).strict();

const body = z.string().trim().min(1).max(16000);
const purpose = z.enum(agentMailPurposes);
const mail = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), to: ref, subject: z.string().trim().min(1).max(200), body,
    purpose: purpose.default('information') }).strict(),
  z.object({ action: z.literal('reply'), message: ref.optional(), body, purpose: purpose.default('information') }).strict(),
  z.object({ action: z.literal('read'), message: ref }).strict(),
  z.object({ action: z.literal('search'), from: ref.optional(), keyword: ref.optional(), subject: ref.optional(),
    purpose: purpose.optional(), unread: z.boolean().optional(), thread: ref.optional(),
    since: z.number().int().nonnegative().optional(), until: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(100).default(20) }).strict(),
]);
const condition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mail'), from: ref.optional(), replyTo: ref.optional(), purpose: purpose.optional() }).strict(),
  z.object({ kind: z.literal('task_state'), task: ref, states: z.array(z.enum(agentTaskStates)).min(1) }).strict(),
  z.object({ kind: z.literal('agent_state'), agent: ref, states: z.array(z.enum(directoryStates)).min(1) }).strict(),
  z.object({ kind: z.literal('run_finished'), agent: ref, run: ref }).strict(),
]);
const wait = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), condition, timeoutMs: z.number().int().min(0).max(3600000).default(30000) }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
]);
const tasksInput = z.object({ command: tasks }).strict();
const mailInput = z.object({ command: mail }).strict();
const waitInput = z.object({ command: wait }).strict();
const interrupt = z.object({ agent: ref }).strict();
const plan = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('replace'), revision: z.number().int().min(0), items: z.array(z.object({
    id: z.string().min(1).max(80), text: z.string().trim().min(1).max(1000), status: z.enum(['pending', 'in_progress', 'completed']),
  }).strict()).max(40) }).strict(),
]);

const planInput = z.object({ command: plan }).strict();

export class AgentTeamToolProvider implements ToolProvider {
  readonly name = 'builtin-agent-team';

  constructor(private readonly coordinator: AgentCoordinator) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      { name: 'list_agent_profiles', inputSchema: empty, description: 'Read available role IDs and descriptions.' },
      { name: 'tasks', inputSchema: tasksInput, description: 'Manage shared tasks. Use #number references. Publish with a role ID as type; autoAssign defaults to true. A child may claim matching ready tasks. The reviewer can accept or reject a submitted result, cancel a task, or retry a failed task. Show includes result and attempt history.' },
      { name: 'delegate_task', inputSchema: delegate, description: 'Root: delegate a ready task to an idle matching child alias, create a child of the matching role, or omit target to request automatic matching. For an explicit target, publish with autoAssign false first.' },
      { name: 'agents', inputSchema: empty, description: 'Find same-root agents by short alias, role, status, current task, and recent run.' },
      { name: 'mail', inputSchema: mailInput, description: 'Communicate with agents in the same root. Use their alias or @parent. Use m#number to read/reply or filter by thread. Use question or urgent for input that may interrupt a wait. Mail does not change task state.' },
      { name: 'wait', inputSchema: waitInput, execution: { concurrency: 'exclusive', standalone: true },
        description: 'Call alone. Start a wait for mail, a task state, an agent state, or a finished run. A durable wait parks this run; the next run receives the matching event, timeout or an unrelated question. After handling an interruption, call resume to keep waiting until the original deadline, or cancel explicitly.' },
      { name: 'interrupt_agent', inputSchema: interrupt, description: 'Root: stop a child, including its active wait and task execution.' },
      { name: 'plan', inputSchema: planInput, description: 'Read or replace the root plan using its revision. The plan is independent of task scheduling.' },
    ];
  }

  async getPermissionRequirement() { return { capability: 'agent.coordinate', action: 'coordinate' }; }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const { session, run } = this.coordinator.activeToolCaller(context.sessionId, context.runId);
    switch (name) {
      case 'list_agent_profiles': return this.coordinator.listProfiles(session);
      case 'agents': return this.coordinator.directory.list(session);
      case 'tasks': {
        const command = tasksInput.parse(input).command;
        switch (command.action) {
          case 'list': return this.coordinator.tasks(session);
          case 'show': return this.coordinator.taskDetails(session, command.task);
          case 'publish': {
            const { action: _, ...draft } = command;
            return this.coordinator.createTask(session, run, context.callId, draft);
          }
          case 'claim': return this.coordinator.claimTask(session, run, context.callId, command.task);
          case 'accept':
          case 'retry': return this.coordinator.decideTask(session, run, context.callId, command.task, { kind: command.action });
          case 'reject':
          case 'cancel': return this.coordinator.decideTask(session, run, context.callId, command.task, { kind: command.action, reason: command.reason });
        }
      }
      case 'delegate_task': {
        const command = delegate.parse(input);
        return this.coordinator.delegateTask(session, run, context.callId, command.task, command.target);
      }
      case 'mail': {
        const command = mailInput.parse(input).command;
        switch (command.action) {
          case 'read': return this.coordinator.mailbox.read(session, command.message);
          case 'search': return this.coordinator.mailbox.search(session, command);
          case 'reply': return this.coordinator.sendMail(session, run, context.callId, { ...command, kind: 'reply' });
          case 'send': return this.coordinator.sendMail(session, run, context.callId, { ...command, kind: 'send' });
        }
      }
      case 'wait': return this.coordinator.wait(session, run, waitInput.parse(input).command);
      case 'interrupt_agent': {
        await this.coordinator.interrupt(session, interrupt.parse(input).agent);
        return { stopped: true };
      }
      case 'plan': {
        const command = planInput.parse(input).command;
        if (command.action === 'read') return this.coordinator.plan(session);
        if (new Set(command.items.map((item) => item.id)).size !== command.items.length) throw new Error('Plan item IDs must be unique.');
        return this.coordinator.updatePlan(session, command.revision, command.items);
      }
      default: throw new Error(`Unknown agent tool: ${name}`);
    }
  }
}
