import { AgentStreamProjector } from '../../contracts/agent-responses/stream-projector.js';
import type { StoredFileService } from '../../stored-files/stored-file-service.js';
import { isTerminalRun, type AgentDomainEvent, type AgentRunRecord } from '../agent-domain.js';
import type { AgentStreamEvent } from '../../../shared/agent/responses.js';
import type { AgentTreeEvent } from '../../../shared/agent/coordination.js';

export class AgentEventHub {
  private readonly listeners = new Set<(event: AgentTreeEvent) => void>();
  private readonly projectors = new Map<string, AgentStreamProjector>();

  constructor(private readonly files: StoredFileService) {}

  subscribe(listener: (event: AgentTreeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  publish(event: AgentTreeEvent): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* A viewer cannot fail an agent run. */ }
    }
  }

  project(run: AgentRunRecord, event: AgentDomainEvent): AgentStreamEvent[] {
    let projector = this.projectors.get(run.id);
    if (!projector) {
      projector = new AgentStreamProjector(this.files.describeForSession.bind(this.files));
      this.projectors.set(run.id, projector);
    }
    const events = projector.project(run, event);
    if (isTerminalRun(run)) this.projectors.delete(run.id);
    return events;
  }
}
