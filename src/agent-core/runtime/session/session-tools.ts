import type { Logger } from "../../observability/logger.js";
import type {
  PreparedToolCall, ToolCallContext, ToolExecutionAuthorization, ToolRegistry,
} from "../../tools/registry.js";
import type { AgentRunRecord } from "../agent-domain.js";
import type { SessionProcessAccess } from "../process/process-types.js";
import type { ToolCall, ToolResult } from "../transcript.js";
import type { Session, WorkspaceStore } from "../workspace-store.js";
import { allowedAgentTool } from "../multi-agents/agent-tool-policy.js";
import { executionScopeForSession } from "../execution-admission.js";
import type { WorkspaceWrites } from "../workspace-writes.js";

const FILE_MUTATIONS = new Set(["filesystem.write", "filesystem.patch", "filesystem.move", "filesystem.delete"]);

export class SessionTools {
  constructor(
    private readonly session: Session,
    private readonly registry: ToolRegistry,
    private readonly workspace: WorkspaceStore,
    private readonly writes: WorkspaceWrites,
    private readonly processes: SessionProcessAccess,
    private readonly logger: Logger,
  ) {}

  async listTools(run: AgentRunRecord) {
    return (await this.registry.listTools(run.modelSnapshot.capabilities)).filter((tool) => this.allows(tool.name, run));
  }

  async prepareToolCall(toolCall: ToolCall, run: AgentRunRecord, available: ReadonlySet<string>): Promise<PreparedToolCall> {
    const denied = this.denied(toolCall, run);
    if (denied) return { ok: false, result: denied };
    const prepared = await this.registry.prepareToolCall(toolCall);
    if (!prepared.ok || available.has(toolCall.name)) return prepared;
    return { ok: false, result: this.unavailable(toolCall) };
  }

  getPermissionRequirement(toolCall: ToolCall, run: AgentRunRecord, signal: AbortSignal) {
    return this.registry.getPermissionRequirement(toolCall, this.context(toolCall, run, signal));
  }

  getExecutionPolicy(toolCall: ToolCall) {
    return this.registry.getExecutionPolicy(toolCall);
  }

  async callTool(toolCall: ToolCall, run: AgentRunRecord, signal: AbortSignal, authorization: ToolExecutionAuthorization) {
    const denied = this.denied(toolCall, run);
    if (denied) return denied;
    const context = this.context(toolCall, run, signal, authorization);
    const execute = () => this.registry.callTool(toolCall, context);
    if (!FILE_MUTATIONS.has(authorization.requirement.capability)) return execute();
    return this.writes.run(executionScopeForSession(this.session).key, signal, execute);
  }

  private allows(name: string, run: AgentRunRecord): boolean {
    return allowedAgentTool(name, !!this.session.parentSessionId, run.permissionSnapshot.permissionMode);
  }

  private denied(toolCall: ToolCall, run: AgentRunRecord): ToolResult | undefined {
    if (!this.allows(toolCall.name, run)) {
      return { toolCallId: toolCall.id, toolName: toolCall.name, ok: false, error: "Tool is disabled by the subagent's permissions." };
    }
    if (!run.modelSnapshot.capabilities.toolCalling) return this.unavailable(toolCall);
  }

  private unavailable(toolCall: ToolCall): ToolResult {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      ok: false,
      error: `Tool ${toolCall.name} is unavailable for the current model. Switch to a model supporting its required input capabilities.`,
    };
  }

  private context(toolCall: ToolCall, run: AgentRunRecord, signal: AbortSignal, authorization?: ToolExecutionAuthorization): ToolCallContext {
    const session = this.session;
    return {
      cwd: session.cwd,
      permissionMode: run.permissionSnapshot.permissionMode,
      ...(session.parentSessionId ? {
        isSubagent: true,
        fileEditRoots: [...(session.cwd ? [session.cwd] : []), ...(session.additionalWorkspacePaths ?? [])],
      } : {}),
      sessionId: session.id,
      runId: run.id,
      callId: toolCall.id,
      signal,
      processes: this.processes,
      modelCapabilities: run.modelSnapshot.capabilities,
      ...(authorization ? {
        authorization,
        recordFileChange: async ({ filePath, created, before, after }) => {
          if (!created && before !== undefined && before === after) return;
          try {
            await this.workspace.addFileChange(session, {
              runId: run.id,
              filePath,
              changeType: created ? "create" : "modify",
              summary: toolCall.name,
              ...(before === undefined ? {} : { oldContent: before }),
              ...(after === undefined ? {} : { newContent: after }),
            });
          } catch (error) {
            this.logger.warn({
              event: "agent.file_change.record_failed",
              sessionId: session.id,
              responseId: run.id,
              model: run.modelSnapshot.targetId,
              ...(session.projectId ? { projectId: session.projectId } : {}),
              error: String(error),
            });
          }
        },
      } : {}),
    };
  }
}
