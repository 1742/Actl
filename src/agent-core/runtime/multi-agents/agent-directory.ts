import type { AgentCoordinationRepository, DirectoryState } from '../../repositories/agent-coordination-repository.js';
import type { Session, WorkspaceStore } from '../workspace-store.js';
import { DEFAULT_AGENT_PROFILE } from './agent-profile-catalog.js';
import { agentAlias, runAlias } from './coordination-references.js';

export class AgentDirectory {
  constructor(private readonly workspace: WorkspaceStore, private readonly state: AgentCoordinationRepository) {}

  async list(session: Session) {
    const rootId = session.rootSessionId ?? session.id;
    const agents = [];
    for (const member of await this.members(rootId, session.ownerId)) {
      const latest = member.runs.at(-1);
      const task = this.state.activeTask(rootId, member.id);
      agents.push({
        agent: agentAlias(member), title: member.title, role: (member.profile ?? DEFAULT_AGENT_PROFILE).id,
        status: directoryState(this.state, member), currentTask: task ? `#${task.number}` : null,
        recentActivity: latest ? { run: runAlias(latest.id), status: latest.status, at: latest.updatedAt } : null,
      });
    }
    return agents;
  }

  async members(rootId: string, ownerId: string): Promise<Session[]> {
    const members: Session[] = [];
    for (const record of this.workspace.descendants(rootId)) {
      const member = await this.workspace.getSession(record.id, ownerId);
      if (member) members.push(member);
    }
    return members;
  }

  /** Find agent/session by id or reference. */
  async resolve(session: Session, ref: string): Promise<Session> {
    const rootId = session.rootSessionId ?? session.id;
    const members = this.workspace.descendants(rootId);
    const exact = ref === '@self' ? session.id : ref === '@parent' ? session.parentSessionId : null;
    const matches = exact ? members.filter((member) => member.id === exact) : members.filter((member) =>
      member.id === ref || agentAlias(member) === ref || (member.parentSessionId && `@${(member.profile ?? DEFAULT_AGENT_PROFILE).id}` === ref));
    if (matches.length !== 1) throw new Error(matches.length ? 'Agent reference is ambiguous. Choose an alias from agents.' : 'Agent does not belong to this root.');
    const member = await this.workspace.getSession(matches[0]!.id, session.ownerId);
    if (!member) throw new Error('Agent no longer exists.');
    return member;
  }

  alias(session: Session, id: string): string {
    return agentAlias({ id, parentSessionId: id === (session.rootSessionId ?? session.id) ? null : 'member' });
  }
}

export function directoryState(state: Pick<AgentCoordinationRepository, 'isStopped' | 'wait' | 'activeTask'>, session: Session): DirectoryState {
  if (state.isStopped(session.id)) return 'stopped';
  const latest = session.runs.at(-1);
  if (latest?.status === 'waiting_permission') return 'waiting_permission';
  if (latest?.status === 'in_progress') {
    const wait = state.wait(session.id);
    return wait?.runId === latest.id && wait.interruptedCallId === null ? 'waiting' : 'running';
  }
  return state.activeTask(session.rootSessionId ?? session.id, session.id)?.status === 'assigned' ? 'assigned' : 'idle';
}
