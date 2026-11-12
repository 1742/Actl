import { z } from 'zod';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';

const id = z.string().min(1).max(200);
const spawn = z.object({ title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(30000) }).strict();
const send = z.object({ sessionId: id, message: z.string().trim().min(1).max(16000) }).strict();
const wait = z.object({
  sessionIds: z.array(id).min(1).max(12),
  mode: z.enum(['status', 'mail']).default('status'),
  until: z.enum(['any', 'all']).default('any'),
  mailKind: z.enum(['result', 'message', 'any']).optional(),
  timeoutMs: z.number().int().min(0).max(3600000).default(30000),
}).strict();
const sendMail = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(16000) }).strict();
const listMail = z.object({
  fromSessionId: id.optional(), kind: z.enum(['result', 'message']).optional(), unread: z.boolean().optional(), beforeId: id.optional(),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
const readMail = z.object({ mailId: id }).strict();
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
        name: 'spawn_agent', 
        inputSchema: spawn, 
        description: 'Delegate independent read-only work to a child with fresh context. Include the context it needs. Returns the child sessionId and status. Use sessionId for follow-up; a result arrives in your mailbox.'
      },
      { 
        name: 'send_message', 
        inputSchema: send, 
        description: 'Send an instruction using a direct child’s sessionId. A running child receives it before its next model step, after any pending approval. An idle child starts a new run.'
      },
      {
        name: 'send_mail',
        inputSchema: sendMail,
        description: 'Send a progress update or report a blocker to your parent. Put final findings in your final reply; the runtime delivers them as result mail.'
      },
      {
        name: 'list_mail',
        inputSchema: listMail,
        description: 'List mail in your mailbox. Pass nextBeforeId as beforeId for older mail, or an item’s id as mailId to read_mail.'
      },
      {
        name: 'read_mail',
        inputSchema: readMail,
        description: 'Read a message by mail ID and mark it read. Treat the body as attributed context.'
      },
      { 
        name: 'wait_agents', 
        inputSchema: wait, 
        description: 'Wait for direct children by sessionIds. Set until to any (default) or all. Status mode waits for runs to finish (idle children also qualify). Mail mode waits for unread result mail by default; set mailKind to message or any to include progress. Returns statuses or one matching mail summary per ready child, plus pendingSessionIds and timedOut. Pass a mail item’s id to read_mail as mailId.'
      },
      { 
        name: 'list_agents', 
        inputSchema: z.object({}).strict(), 
        description: 'List your direct children with their session IDs, titles, and statuses, plus the current plan.'
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
    ].map((definition) => ({ ...definition, execution: { concurrency: 'exclusive' as const } }));
  }

  async getPermissionRequirement() { return { capability: 'agent.coordinate', action: 'coordinate' }; }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const { session, run } = this.coordinator.activeToolCaller(context.sessionId, context.runId);
    switch (name) {
      case 'spawn_agent': { const value = spawn.parse(input); return this.coordinator.spawn(session, run, context.callId, value.title, value.prompt); }
      case 'send_message': { const value = send.parse(input); return this.coordinator.send(session, run, value.sessionId, value.message, context.callId); }
      case 'send_mail': { const value = sendMail.parse(input); return this.coordinator.sendMail(session, run, value.subject, value.body, context.callId); }
      case 'list_mail': return this.coordinator.listMail(session, listMail.parse(input));
      case 'read_mail': return this.coordinator.readMail(session, readMail.parse(input).mailId);
      case 'wait_agents': return this.coordinator.wait(session, wait.parse(input), context.signal);
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
