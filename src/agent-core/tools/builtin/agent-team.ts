import { z } from 'zod';
import { agentMailPurposes, agentTaskStates } from '../../../shared/agent/coordination.js';
import { directoryStates } from '../../repositories/agent-coordination-repository.js';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';
import { MAX_AGENT_NAME_LENGTH } from '../../runtime/multi-agents/agent-name.js';

const ref = z.string().trim().min(1).max(200);
const taskRef = z.preprocess((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : value, ref);
const role = z.string().regex(/^[a-z][a-z0-9-]*$/).max(80);
const reason = z.string().trim().min(1).max(6000);
const empty = z.object({}).strict();
function decodeCommand(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

const tasks = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('show'), task: taskRef.optional() }).strict(),
  z.object({
    action: z.literal('publish'), title: z.string().trim().min(1).max(100),
    instructions: z.string().trim().min(1).max(20000), acceptanceCriteria: reason, type: role,
    blockedBy: z.array(taskRef).max(32).optional(), autoAssign: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal('claim'), task: taskRef }).strict(),
  z.object({ action: z.literal('accept'), task: taskRef }).strict(),
  z.object({ action: z.literal('reject'), task: taskRef, reason }).strict(),
  z.object({ action: z.literal('cancel'), task: taskRef, reason }).strict(),
  z.object({ action: z.literal('retry'), task: taskRef }).strict(),
]);
const delegate = z.object({ task: taskRef, target: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agent: ref }).strict(),
  z.object({ kind: z.literal('create'), role, name: z.string().trim().min(1).max(MAX_AGENT_NAME_LENGTH).optional()
    .describe('A unique name in this root, without the @ prefix. Defaults to an available role-based name.') }).strict(),
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
  z.object({ kind: z.literal('task_state'), task: taskRef, states: z.array(z.enum(agentTaskStates)).min(1) }).strict(),
  z.object({ kind: z.literal('agent_state'), agent: ref, states: z.array(z.enum(directoryStates)).min(1) }).strict(),
  z.object({ kind: z.literal('run_finished'), agent: ref, run: ref }).strict(),
]);
const wait = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), condition, timeoutMs: z.number().int().min(0).max(3600000).default(30000) }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
]);
const tasksInput = z.object({ command: z.preprocess(decodeCommand, tasks) }).strict();
const mailInput = z.object({ command: z.preprocess(decodeCommand, mail) }).strict();
const waitInput = z.object({ command: z.preprocess(decodeCommand, wait) }).strict();
const childAgent = z.object({ agent: ref }).strict();
const plan = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z.object({ action: z.literal('replace'), revision: z.number().int().min(0), items: z.array(z.object({
    id: z.string().min(1).max(80), text: z.string().trim().min(1).max(1000), status: z.enum(['pending', 'in_progress', 'completed']),
  }).strict()).max(40) }).strict(),
]);

const planInput = z.object({ command: z.preprocess(decodeCommand, plan) }).strict();

export class AgentTeamToolProvider implements ToolProvider {
  readonly name = 'builtin-agent-team';

  constructor(private readonly coordinator: AgentCoordinator) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      { name: 'list_agent_profiles', inputSchema: empty, description: 'Read available role IDs, workspace access, and descriptions. Use the build role for scoped changes.' },
      { name: 'tasks', inputSchema: tasksInput, description: 'Manage shared tasks. Use #number references. Show without task reads your current assignment. Show includes result and attempt history. Publish with a role ID as type; autoAssign defaults to true and reuses existing idle agents. If no idle agent matches, the task stays pending. A child may claim matching ready tasks. The reviewer can accept or reject a submitted result, cancel a task, or retry a failed task.' },
      { name: 'delegate_task', inputSchema: delegate, description: 'Root: delegate a ready task to an idle matching child by @name, create a child of the matching role with a unique name, or omit target for automatic matching. Publish with autoAssign false before explicit delegation. Use the returned attempt.agent to address the child.' },
      { name: 'agents', inputSchema: empty, description: 'List same-root agents by name and @name reference, with role, status, current task, and recent run.' },
      { name: 'mail', inputSchema: mailInput, description: 'Use @name or @parent for recipient and sender filters. Use m#number to read/reply or filter by thread. Use question or urgent for input that may interrupt a wait. Mail does not change task state.' },
      { name: 'wait', inputSchema: waitInput, execution: { concurrency: 'exclusive', standalone: true },
        description: 'Call alone. Start a wait for mail, a task state, an agent state, or a finished run. Use @name or @parent to identify the sender or agent. After handling an interruption, call resume to keep the original deadline or cancel explicitly.' },
      { name: 'interrupt_agent', inputSchema: childAgent, description: 'Root: cancel the current run, wait, and task for a child. The child remains available for new work.' },
      { name: 'retire_agent', inputSchema: childAgent, description: 'Root: retire an idle or stopped child without an active task, freeing a child agent slot. Its conversation and task history remain available.' },
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
      case 'wait': return this.coordinator.wait(session, run, context.callId, waitInput.parse(input).command, context.signal);
      case 'interrupt_agent': {
        await this.coordinator.interrupt(session, childAgent.parse(input).agent);
        return { stopped: true };
      }
      case 'retire_agent': return this.coordinator.retireChild(session, childAgent.parse(input).agent);
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
