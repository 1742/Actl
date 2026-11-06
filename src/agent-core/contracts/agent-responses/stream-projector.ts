import type { TranscriptMessage, TranscriptReasoning } from "../../model/types.js";
import type { AgentDomainEvent, AgentRunRecord, AgentTimelineItem } from "../../runtime/agent-domain.js";
import { toAgentItemDto, toAgentResponseDto, toPendingPermissionBatchDto, type StoredFileMetadataResolver } from "./presenter.js";
import type { AgentStreamEvent, AgentStreamEventPayload } from "./types.js";

export class AgentStreamProjector {
  private readonly announcedParts = new Set<string>();

  constructor(private readonly resolveStoredFile?: StoredFileMetadataResolver) {}

  project(run: AgentRunRecord, event: AgentDomainEvent): AgentStreamEvent[] {
    const payloads = this.projectPayload(event);
    return payloads.map((payload) => ({
      ...payload,
      response_id: run.id,
      sequence_number: run.nextSequenceNumber++,
    } as AgentStreamEvent));
  }

  private projectPayload(event: AgentDomainEvent): AgentStreamEventPayload[] {
    if (event.type === "run_created") return [{ type: "response.created", response: toAgentResponseDto(event.run, this.resolveStoredFile) }];
    if (event.type === "run_completed") return [{ type: "response.completed", response: toAgentResponseDto(event.run, this.resolveStoredFile) }];
    if (event.type === "run_failed") return [{ type: "response.failed", response: toAgentResponseDto(event.run, this.resolveStoredFile) }];
    if (event.type === "run_incomplete") return [{ type: "response.incomplete", response: toAgentResponseDto(event.run, this.resolveStoredFile) }];
    if (event.type === "run_cancelled") return [{ type: "response.cancelled", response: toAgentResponseDto(event.run, this.resolveStoredFile) }];
    if (event.type === "item_started") return [{
      type: "response.output_item.added",
      output_index: event.outputIndex,
      item: toAgentItemDto(event.item, "in_progress"),
    }];
    if (event.type === "text_delta") {
      const events = this.ensureMessagePart(event.itemId, event.outputIndex, event.contentIndex);
      events.push({ type: "response.output_text.delta", item_id: event.itemId, output_index: event.outputIndex, content_index: event.contentIndex, delta: event.delta });
      return events;
    }
    if (event.type === "reasoning_delta") {
      if (event.section === "content") return [{
        type: "response.reasoning_text.delta", item_id: event.itemId, output_index: event.outputIndex,
        content_index: event.contentIndex, delta: event.delta,
      }];
      const events = this.ensureReasoningPart(event.itemId, event.outputIndex, event.contentIndex);
      events.push({ type: "response.reasoning_summary_text.delta", item_id: event.itemId, output_index: event.outputIndex, summary_index: event.contentIndex, delta: event.delta });
      return events;
    }
    if (event.type === "tool_arguments_delta") return [{ type: "response.function_call_arguments.delta", item_id: event.itemId, output_index: event.outputIndex, delta: event.delta }];
    if (event.type === "item_completed") return this.completeItem(event.item, event.outputIndex);
    if (event.type === "tool_completed") return [{ type: "agent.tool.completed", item_id: event.itemId, call_id: event.callId, result: event.result }];
    if (event.type === "permissions_requested") return [{
      type: "agent.permissions.requested",
      batch: toPendingPermissionBatchDto(event.batch),
    }];
    if (event.type === "permissions_resolved") return [{
      type: "agent.permissions.resolved",
      batch_id: event.batchId,
      decisions: event.decisions.map((decision) => ({
        permission_id: decision.permissionId,
        decision: decision.decision,
        ...(decision.reason ? { reason: decision.reason } : {}),
      })),
    }];
    return [{ type: "error", code: event.code, message: event.message, param: event.param }];
  }

  private completeItem(item: AgentTimelineItem, outputIndex: number): AgentStreamEventPayload[] {
    const events: AgentStreamEventPayload[] = [];
    if (item.type === "message") {
      const message = item as TranscriptMessage;
      message.content.forEach((part, contentIndex) => {
        if (part.type !== "text" && part.type !== "refusal") return;
        const key = this.partKey("message", message.id, contentIndex);
        if (!this.announcedParts.has(key)) {
          this.announcedParts.add(key);
          events.push({ type: "response.content_part.added", item_id: message.id, output_index: outputIndex, content_index: contentIndex, part: part.type === "text" ? { type: "output_text", text: "", annotations: [] } : { type: "refusal", refusal: part.reason } });
        }
        if (part.type === "text") events.push({ type: "response.output_text.done", item_id: message.id, output_index: outputIndex, content_index: contentIndex, text: part.text });
        events.push({ type: "response.content_part.done", item_id: message.id, output_index: outputIndex, content_index: contentIndex, part: part.type === "text" ? { type: "output_text", text: part.text, annotations: [] } : { type: "refusal", refusal: part.reason } });
      });
    } else if (item.type === "reasoning") {
      const reasoning = item as TranscriptReasoning;
      reasoning.summary.forEach((part, summaryIndex) => {
        if (part.type !== "text") return;
        const key = this.partKey("reasoning", reasoning.id, summaryIndex);
        if (!this.announcedParts.has(key)) {
          this.announcedParts.add(key);
          events.push({ type: "response.reasoning_summary_part.added", item_id: reasoning.id, output_index: outputIndex, summary_index: summaryIndex, part: { type: "summary_text", text: "" } });
        }
        events.push({ type: "response.reasoning_summary_text.done", item_id: reasoning.id, output_index: outputIndex, summary_index: summaryIndex, text: part.text });
        events.push({ type: "response.reasoning_summary_part.done", item_id: reasoning.id, output_index: outputIndex, summary_index: summaryIndex, part: { type: "summary_text", text: part.text } });
      });
      reasoning.content.forEach((part, contentIndex) => {
        if (part.type !== "text") return;
        events.push({ type: "response.reasoning_text.done", item_id: reasoning.id, output_index: outputIndex, content_index: contentIndex, text: part.text });
      });
    } else if (item.type === "tool_call") {
      events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index: outputIndex, arguments: item.argumentsJson });
    }
    events.push({ type: "response.output_item.done", output_index: outputIndex, item: toAgentItemDto(item, "completed") });
    return events;
  }

  private ensureMessagePart(itemId: string, outputIndex: number, contentIndex: number): AgentStreamEventPayload[] {
    const key = this.partKey("message", itemId, contentIndex);
    if (this.announcedParts.has(key)) return [];
    this.announcedParts.add(key);
    return [{ type: "response.content_part.added", item_id: itemId, output_index: outputIndex, content_index: contentIndex, part: { type: "output_text", text: "", annotations: [] } }];
  }

  private ensureReasoningPart(itemId: string, outputIndex: number, summaryIndex: number): AgentStreamEventPayload[] {
    const key = this.partKey("reasoning", itemId, summaryIndex);
    if (this.announcedParts.has(key)) return [];
    this.announcedParts.add(key);
    return [{ type: "response.reasoning_summary_part.added", item_id: itemId, output_index: outputIndex, summary_index: summaryIndex, part: { type: "summary_text", text: "" } }];
  }

  private partKey(kind: string, itemId: string, index: number): string {
    return `${kind}:${itemId}:${index}`;
  }
}
