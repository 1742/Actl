import type { AgentTask, TaskAttempt } from '../../../shared/agent/coordination.js';
import type { TranscriptMessage } from '../../model/types.js';
import type { ReviewNotification } from '../../repositories/agent-coordination-repository.js';
import { createRandomId } from '../../utils.js';
import type { Session } from '../workspace-store.js';
import { DEFAULT_AGENT_PROFILE } from './agent-profile-catalog.js';

export function runtimeInput(text: string): TranscriptMessage {
  return { id: createRandomId('coordination'), type: 'message', role: 'user', source: { kind: 'runtime' }, content: [{ type: 'text', text }] };
}

export function reviewNotificationInput(reviews: readonly ReviewNotification[]): TranscriptMessage {
  return runtimeInput(`Results are ready for review: ${reviews.map((event) => `#${event.taskNumber}`).join(', ')}. Use tasks show.`);
}

export function initialAgentRoleInput(session: Session): TranscriptMessage | undefined {
  if (!session.parentSessionId || session.runs.length > 0) return undefined;

  const profile = session.profile ?? DEFAULT_AGENT_PROFILE;
  return runtimeInput(`Role selected by @parent: ${JSON.stringify(profile.name)} (${profile.id})\n\n${profile.instructions}`);
}

export function taskAssignmentInput(session: Session, task: AgentTask, previous?: TaskAttempt): TranscriptMessage {
  const text = [
    `Begin task #${task.number}: ${task.title}`,
    ...(session.parentSessionId ? ['Assigned by @parent.'] : []),
    `Instructions:\n${task.instructions}`,
    `Acceptance criteria:\n${task.acceptanceCriteria}`,
    ...(previous?.reason ? [`Previous attempt (${previous.outcome}): ${previous.reason}`] : []),
  ].join('\n\n');
  return runtimeInput(text);
}
