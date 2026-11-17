import type { ChildRunResult } from '../../../shared/agent/coordination.js';
import { toAgentItemDto } from '../../contracts/agent-responses/presenter.js';
import type { AgentRunRecord } from '../agent-domain.js';
import type { Session } from '../workspace-store.js';

export function childRunResults(sessions: Session[], taskSources: ReadonlyMap<string, string>): ChildRunResult[] {
  const parents = new Map(sessions.map((session) => [session.id, session]));
  const results: ChildRunResult[] = [];
  for (const session of sessions) {
    const parent = session.parentSessionId && parents.get(session.parentSessionId);
    if (!parent) continue;
    const parentRuns = new Set(parent.runs.map(({ id }) => id));
    const changedRuns = new Set(session.fileChanges.map(({ runId }) => runId));
    for (const run of session.runs) {
      if (!run.completedAt) continue;
      const hasFileChanges = changedRuns.has(run.id);
      const searchOutput = webSearchOutput(run);
      if (!hasFileChanges && !searchOutput.length) continue;

      // Delegation keeps its originating run even if the parent has since started another.
      const source = taskSources.get(run.id);
      const parentRunId = source && parentRuns.has(source) ? source
        : parent.runs.findLast(({ createdAt }) => createdAt <= run.createdAt)?.id;
      if (parentRunId) results.push({ parentRunId, sessionId: session.id, runId: run.id, hasFileChanges, searchOutput });
    }
  }
  return results;
}

function webSearchOutput(run: AgentRunRecord) {
  const searches = new Set(run.timeline.flatMap((item) =>
    item.type === 'tool_call' && item.name === 'web_search' ? [item.callId] : [],
  ));
  return run.timeline.filter((item) =>
    item.type === 'web_search' ||
    ((item.type === 'tool_call' || item.type === 'tool_result') && searches.has(item.callId)),
  ).map((item) => toAgentItemDto(item, 'completed'));
}
