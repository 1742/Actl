import { z } from 'zod';
import type { ToolProvider, ToolDefinition, ToolCallContext } from '../registry.js';
import type { AgentCoordinator } from '../../runtime/multi-agents/agent-coordinator.js';

const id = z.string().min(1).max(200);
const spawn = z.object({ title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(30000) }).strict();
const send = z.object({
  sessionId: id.describe('Your direct parent or direct child session ID.'),
  message: z.string().trim().min(1).max(16000),
  purpose: z.enum(['message', 'progress', 'clarification']).optional(),
  replyTo: id.describe('Message ID from the recipient that you are answering.').optional(),
}).strict();
const wait = z.object({
  sessionIds: z.array(id).min(1).max(12),
  until: z.enum(['any', 'all']).default('any'),
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
        name: 'spawn_agent', 
        inputSchema: spawn, 
        description: 'Delegate independent read-only work to a child with fresh context. Include the context it needs. Returns the child sessionId and status. Use that ID to follow up or collect the result with wait_agents.'
      },
      { 
        name: 'send_message', 
        inputSchema: send, 
        description: 'Send a message to your direct parent or child. Returns the accepted message ID. The recipient sees it at its next model step. An idle child starts a run; an idle parent sees it on its next turn. Use purpose progress for updates or clarification for questions.'
      },
      { 
        name: 'wait_agents', 
        inputSchema: wait, 
        description: 'Wait for direct children by sessionIds until any (default) or all have no active or queued work. Returns each child’s status and latest run ID when available, with final output on success or an error when available. Returns pendingSessionIds and timedOut. Progress and clarification messages arrive at your next model step.'
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
      case 'send_message': {
        const { sessionId, message, purpose, replyTo } = send.parse(input);
        return this.coordinator.send(session, run, sessionId, message, context.callId, { purpose, replyTo });
      }
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
