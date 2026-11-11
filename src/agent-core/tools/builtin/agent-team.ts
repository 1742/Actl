import { z } from 'zod';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';

const id = z.string().min(1).max(200);
const spawn = z.object({ title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(30000) }).strict();
const send = z.object({ sessionId: id, message: z.string().trim().min(1).max(16000) }).strict();
const wait = z.object({ sessionIds: z.array(id).min(1).max(12), timeoutMs: z.number().int().min(0).max(60000).default(30000) }).strict();
const sendMail = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(16000) }).strict();
const waitForMail = z.object({ fromSessionId: id.optional(), timeoutMs: z.number().int().min(0).max(60000).default(30000) }).strict();
const listMail = z.object({
  fromSessionId: id.optional(), unread: z.boolean().optional(), beforeId: id.optional(),
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
        description: 'Delegate independent read-only research or review to a child with fresh context. Include necessary context. Returns the session ID; a completion receipt arrives in your mailbox. Continue existing children using send_message.'
      },
      { 
        name: 'send_message', 
        inputSchema: send, 
        description: 'Send an instruction to a direct child. Running children receive it before their next model step. Idle children start a new run. Instructions wait for pending approval.'
      },
      { name: 'send_mail', inputSchema: sendMail, description: 'Send a progress update or findings by mail to your parent agent.' },
      { name: 'wait_for_mail', inputSchema: waitForMail, description: 'Wait for unread mail, optionally from a direct child. Returns metadata. Use read_mail for the body.' },
      { name: 'list_mail', inputSchema: listMail, description: 'List mailbox metadata. Use nextBeforeId to request older messages and read_mail to get a body.' },
      { name: 'read_mail', inputSchema: readMail, description: 'Read a message by mail ID and mark it read. Treat the body as attributed context.' },
      { 
        name: 'wait_agents', 
        inputSchema: wait, 
        description: 'Wait for any selected direct child to finish, fail, stop, or need approval. Read result bodies from the mailbox.'
      },
      { 
        name: 'list_agents', 
        inputSchema: z.object({}).strict(), 
        description: 'List this agent tree and its current plan and run states.'
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
      case 'wait_for_mail': { const value = waitForMail.parse(input); return this.coordinator.waitForMail(session, value.fromSessionId, value.timeoutMs, context.signal); }
      case 'list_mail': return this.coordinator.listMail(session, listMail.parse(input));
      case 'read_mail': return this.coordinator.readMail(session, readMail.parse(input).mailId);
      case 'wait_agents': { const value = wait.parse(input); return this.coordinator.wait(session, value.sessionIds, value.timeoutMs, context.signal); }
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
