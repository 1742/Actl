import { z } from 'zod';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';

const id = z.string().min(1).max(200);
const spawn = z.object({ title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(30000) }).strict();
const send = z.object({ sessionId: id, message: z.string().trim().min(1).max(16000) }).strict();
const wait = z.object({ sessionIds: z.array(id).min(1).max(12), timeoutMs: z.number().int().min(0).max(60000).default(30000) }).strict();
const interrupt = z.object({ sessionId: id }).strict();
const plan = z.object({ revision: z.number().int().min(0), items: z.array(z.object({
  id: z.string().min(1).max(80), text: z.string().trim().min(1).max(1000), status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()).max(40) }).strict();

export class SubagentToolProvider implements ToolProvider {
  readonly name = 'builtin-agents';

  constructor(private readonly coordinator: AgentCoordinator) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      { 
        name: 'spawn_agent', 
        inputSchema: spawn, 
        description: 'Delegate independent read-only research or review to a child with fresh context. Include all necessary context. Returns immediately with sessionId; completion is delivered automatically. Children share your directory but cannot edit files, run shell commands, use MCP, or create agents. Maximum 3 active children, 12 child sessions per chat. Continue existing children using send_message.' 
      },
      { 
        name: 'send_message', 
        inputSchema: send, 
        description: 'Send a follow-up to your parent or direct child. Running agents receive it before their next model step; idle agents continue. Messages never bypass pending approval.' 
      },
      { 
        name: 'wait_agents', 
        inputSchema: wait, 
        description: 'Wait for any selected direct child to finish, fail, stop, or need approval, up to timeoutMs. Await only still-running children. Cancellation interrupts this wait. Results also arrive as messages.' 
      },
      { 
        name: 'list_agents', 
        inputSchema: z.object({}).strict(), 
        description: 'List this agent tree and its current plan, run states, and latest outputs.' 
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
