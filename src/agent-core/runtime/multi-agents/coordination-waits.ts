import type { AgentMail } from '../../../shared/agent/coordination.js';
import type { AgentCoordinationRepository, AgentWait, WaitOutcome } from '../../repositories/agent-coordination-repository.js';
import { isTerminalRun } from '../agent-domain.js';
import type { WorkspaceStore } from '../workspace-store.js';

import { directoryState } from './agent-directory.js';

export class CoordinationWaits {
  constructor(private readonly state: AgentCoordinationRepository, private readonly workspace: WorkspaceStore) {}

  async outcome(wait: Omit<AgentWait, 'id'>, initial = false): Promise<WaitOutcome | undefined> {
    const condition = wait.condition;
    const beforeDeadline = initial || Date.now() <= wait.deadline;
    switch (condition.kind) {
      case 'mail': {
        const candidates = condition.replyTo
          ? this.state.replies(wait.sessionId, condition.replyTo)
          : this.state.pendingMail(wait.sessionId);
        const message = candidates.find((mail) => matchesWaitMail(wait, mail));
        if (message) return { kind: 'mail', message };
        break;
      }
      case 'task_state': {
        const observed = this.state.observedTaskState(wait.rootId, condition.task, condition.states, wait.cursor, wait.deadline);
        if (observed) return { kind: condition.kind, task: condition.task, state: observed };
        const task = beforeDeadline && this.state.task(wait.rootId, condition.task);
        if (task && condition.states.includes(task.status)) return { kind: condition.kind, task: task.id, state: task.status };
        break;
      }
      case 'agent_state': {
        const observed = this.state.observedAgentState(wait.rootId, condition.agent, condition.states, wait.cursor, wait.deadline);
        if (observed) return { kind: condition.kind, agent: condition.agent, state: observed };
        if (!beforeDeadline) break;
        const agent = await this.workspace.getSession(condition.agent);
        if (!agent) break;
        const status = directoryState(this.state, agent);
        if (condition.states.includes(status)) return { kind: condition.kind, agent: agent.id, state: status };
        break;
      }
      case 'run_finished': {
        const agent = await this.workspace.getSession(condition.agent);
        const run = agent?.runs.find((item) => item.id === condition.run);
        if (run && isTerminalRun(run) && (initial || Date.parse(run.completedAt ?? run.updatedAt) <= wait.deadline)) {
          return { kind: condition.kind, run: run.id, state: run.status, ...(run.finalOutput ? { output: run.finalOutput } : {}) };
        }
        break;
      }
    }
    return Date.now() >= wait.deadline ? { kind: 'timed_out' } : undefined;
  }
}

export function matchesWaitMail(wait: Pick<AgentWait, 'condition' | 'sessionId' | 'deadline'>, mail: AgentMail): boolean {
  const condition = wait.condition;
  return condition.kind === 'mail' && mail.toSessionId === wait.sessionId && mail.createdAt <= wait.deadline &&
    (!condition.from || mail.fromSessionId === condition.from) &&
    (!condition.purpose || mail.purpose === condition.purpose) &&
    (!condition.replyTo || mail.replyTo === condition.replyTo);
}
