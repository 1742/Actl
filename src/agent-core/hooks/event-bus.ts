import { type Session } from "../runtime/workspace-store.js";
import { type ToolCall, type ToolResult } from "../runtime/transcript.js";

export interface RuntimeEventBase {
  session: Session;
}

export interface PreToolUseEvent extends RuntimeEventBase {
  toolCall: ToolCall;
}

export interface PostToolUseEvent extends RuntimeEventBase {
  toolCall: ToolCall;
  toolResult: ToolResult;
}

export interface StopEvent extends RuntimeEventBase {
  response: string;
}

export interface RuntimeEvents {
  PreToolUse: PreToolUseEvent;
  PostToolUse: PostToolUseEvent;
  Stop: StopEvent;
}

export interface HookResult {
  blocked?: boolean;
  reason?: string;
}

export type RuntimeHook<Event> = (event: Event) => HookResult | void | Promise<HookResult | void>;

export interface HookEventBus {
  on<EventName extends keyof RuntimeEvents>(
    eventName: EventName,
    hook: RuntimeHook<RuntimeEvents[EventName]>,
  ): void;
  emit<EventName extends keyof RuntimeEvents>(
    eventName: EventName,
    event: RuntimeEvents[EventName],
  ): Promise<HookResult>;
}

export class InMemoryHookEventBus implements HookEventBus {
  private readonly hooks = new Map<keyof RuntimeEvents, RuntimeHook<RuntimeEvents[keyof RuntimeEvents]>[]>();

  on<EventName extends keyof RuntimeEvents>(
    eventName: EventName,
    hook: RuntimeHook<RuntimeEvents[EventName]>,
  ): void {
    const hooks = this.hooks.get(eventName) ?? [];
    hooks.push(hook as RuntimeHook<RuntimeEvents[keyof RuntimeEvents]>);
    this.hooks.set(eventName, hooks);
  }

  async emit<EventName extends keyof RuntimeEvents>(
    eventName: EventName,
    event: RuntimeEvents[EventName],
  ): Promise<HookResult> {
    const hooks = this.hooks.get(eventName) ?? [];

    for (const hook of hooks) {
      const result = await hook(event);

      if (result?.blocked) {
        return result;
      }
    }

    return {};
  }
}
