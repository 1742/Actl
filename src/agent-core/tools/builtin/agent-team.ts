import { z } from 'zod';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';

const id = z.string().min(1).max(200);
const revision = z.number().int().positive();
const taskChange = z.object({ taskId: id, expectedRevision: revision }).strict();
const taskCreate = z.object({
  title: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(20000),
  acceptanceCriteria: z.string().trim().min(1).max(6000),
  blockedBy: z.array(id).max(32).optional(),
}).strict();
const delegate = taskChange.extend({
  target: z.union([z.object({ profileId: id }).strict(), z.object({ sessionId: id }).strict()]),
});
const complete = taskChange.extend({ runId: id });
const send = z.object({
  sessionId: id.describe('Your direct parent or direct child session ID.'),
  message: z.string().trim().min(1).max(16000),
  purpose: z.enum(['message', 'progress', 'clarification']).optional(),
  replyTo: id.describe('Message ID from the recipient that you are answering.').optional(),
}).strict();
const wait = z.object({
  targets: z.array(z.union([
    z.object({ sessionId: id, runId: id }).strict(),
    z.object({ sessionId: id, messageId: id }).strict(),
  ])).min(1).max(12),
  until: z.enum(['any', 'all']).default('any'),
  timeoutMs: z.number().int().min(0).max(3600000).default(30000),
}).strict();
const waitForMessage = z.object({
  sessionId: id.describe('Your direct parent or direct child session ID.'),
  replyTo: id.describe('ID of the message you sent if you are waiting for its specific reply.').optional(),
  timeoutMs: z.number().int().min(0).max(3600000).default(30000),
}).strict();
const interrupt = z.object({ sessionId: id }).strict();
const plan = z.object({ revision: z.number().int().min(0), items: z.array(z.object({
  id: z.string().min(1).max(80), text: z.string().trim().min(1).max(1000), status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()).max(40) }).strict();

export class AgentTeamToolProvider implements ToolProvider {
  readonly name = 'builtin-agent-team';

  constructor(private readonly coordinator: AgentCoordinator) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: 'list_agent_profiles', inputSchema: z.object({}).strict(),
        description: 'List the role profiles available for delegation. Use a profile ID with delegate_task to start a child with fresh context.',
      },
      {
        name: 'create_task', inputSchema: taskCreate,
        description: 'Create a tracked task with instructions and acceptance criteria. blockedBy optionally lists existing tasks that must first be accepted. Returns the task ID and revision.',
      },
      {
        name: 'list_tasks', inputSchema: z.object({}).strict(),
        description: 'Read the shared tasks, owners, revisions, readiness and accepted results in this conversation.',
      },
      {
        name: 'delegate_task', inputSchema: delegate,
        description: 'Assign a ready task to a child. Choose an available profileId to create a child or an idle direct child sessionId. Returns assignmentId, sessionId, messageId and runId when started. Collect that work with wait_agents.',
      },
      {
        name: 'claim_task', inputSchema: taskChange,
        description: 'Claim a ready task for yourself using its current revision. You may hold one task at a time. Continue its instructions in this run.',
      },
      {
        name: 'release_task', inputSchema: taskChange,
        description: 'Release an assigned task back to the ready queue. The task owner or the root can release it. For another active child, stop it or wait for it first.',
      },
      {
        name: 'complete_task', inputSchema: complete,
        description: 'Accept a task after verification. Provide the current task revision and a result runId from its current assignment. For work you claimed and verified yourself, use your own run ID.',
      },
      { 
        name: 'send_message', 
        inputSchema: send, 
        description: 'Send a message to your direct parent or child. Returns the accepted message ID. The recipient sees it at its next model step. An idle child starts a run; an idle parent sees it on its next turn. Use purpose progress for updates or clarification for questions.'
      },
      { 
        name: 'wait_agents', 
        inputSchema: wait, 
        execution: { concurrency: 'exclusive', standalone: true },
        description: 'Call on its own. Wait for an exact run per direct child. Each target takes sessionId and either runId or messageId from delegation or follow-up. Set until to any (default) or all. Returns statuses with final output or error, pendingSessionIds, needsInput, and timedOut. An unanswered clarification in needsInput ends the wait early; its message is available in your timeline.'
      },
      {
        name: 'wait_for_message',
        inputSchema: waitForMessage,
        execution: { concurrency: 'exclusive', standalone: true },
        description: 'Call on its own. Wait for a pending message from your direct parent or child. Set replyTo to a message ID you sent to wait for its specific reply, including one already delivered. Returns messageId on a match; its body is delivered in the conversation. The current run continues after a match or timeout.'
      },
      { 
        name: 'list_agents', 
        inputSchema: z.object({}).strict(), 
        description: 'List your direct children with their session IDs, titles, statuses, and latest run IDs when available, plus the current plan.'
      },
      { 
        name: 'interrupt_agent', 
        inputSchema: interrupt, 
        description: 'Stop a direct child and its processes, retaining the session history for later continuation.' 
      },
      { 
        name: 'update_plan', 
        inputSchema: plan, 
        description: 'Replace the root chat todo list using its current revision (initially 0). The plan persists across restart and context compaction. Mark work complete only after verification; child run completion alone is not task completion.' 
      },
    ];
  }

  async getPermissionRequirement() { return { capability: 'agent.coordinate', action: 'coordinate' }; }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const { session, run } = this.coordinator.activeToolCaller(context.sessionId, context.runId);
    switch (name) {
      case 'list_agent_profiles': return this.coordinator.listProfiles(session);
      case 'list_tasks': return this.coordinator.tasks(session);
      case 'create_task': return this.coordinator.createTask(session, run, context.callId, taskCreate.parse(input));
      case 'delegate_task': {
        const value = delegate.parse(input);
        return this.coordinator.delegateTask(session, run, context.callId, value.taskId, value.expectedRevision, value.target);
      }
      case 'claim_task': {
        const value = taskChange.parse(input);
        return this.coordinator.claimTask(session, run, context.callId, value.taskId, value.expectedRevision);
      }
      case 'release_task': {
        const value = taskChange.parse(input);
        return this.coordinator.releaseTask(session, value.taskId, value.expectedRevision);
      }
      case 'complete_task': {
        const value = complete.parse(input);
        return this.coordinator.completeTask(session, run, value.taskId, value.expectedRevision, value.runId);
      }
      case 'send_message': {
        const { sessionId, message, purpose, replyTo } = send.parse(input);
        return this.coordinator.send(session, run, sessionId, message, context.callId, { purpose, replyTo });
      }
      case 'wait_agents': return this.coordinator.wait(session, wait.parse(input), context.signal);
      case 'wait_for_message': return this.coordinator.waitForMessage(session, waitForMessage.parse(input), context.signal);
      case 'list_agents': return this.coordinator.list(session);
      case 'interrupt_agent': { await this.coordinator.interrupt(session, interrupt.parse(input).sessionId); return { stopped: true }; }
      case 'update_plan': {
        const value = plan.parse(input);
        if (new Set(value.items.map((item) => item.id)).size !== value.items.length) throw new Error('Plan item IDs must be unique.');
        return this.coordinator.updatePlan(session, value.revision, value.items);
      }
      default: throw new Error(`Unknown agent tool: ${name}`);
    }
  }
}
