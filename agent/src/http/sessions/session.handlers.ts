import type { Request, Response } from "express";
import type { AgentLoop } from "../../runtime/agent-loop/agent-loop.js";
import type { AgentDomainEventHandler } from "../../runtime/agent-domain.js";
import type { Session, WorkspaceStore } from "../../runtime/workspace-store.js";
import type { ProcessSupervisor } from "../../runtime/process/process-supervisor.js";
import { ApiError, toApiError, toApiErrorBody } from "../common/api-error.js";
import { toSessionJson } from "../common/presenters.js";
import { validated } from "../common/validation.js";
import { createSilentLogger, errorFields, type Logger } from "../../observability/logger.js";
import type {
  BindSessionBody,
  CreateResponseBody,
  CompactSessionBody,
  CreateSessionBody,
  ListSessionsQuery,
  ResolvePermissionsBody,
  ResponseParams,
  SessionParams,
  UpdateSessionBody,
} from "./session.schemas.js";
import { inputFromDto, toAgentResponseDto } from "../agent-responses/presenter.js";
import { AgentStreamProjector } from "../agent-responses/stream-projector.js";
import type { AgentStreamEventHandler } from "../agent-responses/types.js";
import type { ResponseInputMessageDto } from "../agent-responses/types.js";
import type { WorkspaceFileService } from "../../runtime/workspace-files.js";
import type { StoredFileService } from "../../stored-files/stored-file-service.js";
import { currentOwnerId } from "../../auth/runtime-auth.js";

export interface SessionHandlerDependencies {
  agentLoop: AgentLoop;
  workspaceStore: WorkspaceStore;
  processSupervisor: ProcessSupervisor;
  workspaceFiles: WorkspaceFileService;
  storedFiles: StoredFileService;
  logger?: Logger;
}

const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

export function createSessionHandlers({
  agentLoop,
  workspaceStore,
  processSupervisor,
  workspaceFiles,
  storedFiles,
  logger = createSilentLogger(),
}: SessionHandlerDependencies) {
  return {
    async createSession(_request: Request, response: Response): Promise<void> {
      const body = validated<CreateSessionBody>(response, "body");
      response.status(201).json(toSessionJson(await workspaceStore.createSession(currentOwnerId(response), {
        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
        ...(body.title === undefined ? {} : { title: body.title }),
      })));
    },

    listSessions(_request: Request, response: Response): void {
      const query = validated<ListSessionsQuery>(response, "query");
      const filter = query.scope === "standalone" ? null : query.projectId;
      response.json(workspaceStore.listSessions(currentOwnerId(response), filter).map(toSessionJson));
    },

    async getSession(_request: Request, response: Response): Promise<void> {
      response.json(toSessionJson(await findSession(response)));
    },

    async updateSession(_request: Request, response: Response): Promise<void> {
      const { sessionId } = validated<SessionParams>(response, "params");
      const { title } = validated<UpdateSessionBody>(response, "body");
      response.json(toSessionJson(await workspaceStore.updateSession(currentOwnerId(response), sessionId, title ?? undefined)));
    },

    async bindSession(_request: Request, response: Response): Promise<void> {
      const { sessionId } = validated<SessionParams>(response, "params");
      const { projectId } = validated<BindSessionBody>(response, "body");
      await findSession(response);
      response.json(toSessionJson(await agentLoop.withIdleSessionScopeMaintenance(
        sessionId,
        () => workspaceStore.bindSession(currentOwnerId(response), sessionId, projectId),
      )));
    },

    async deleteSession(_request: Request, response: Response): Promise<void> {
      const { sessionId } = validated<SessionParams>(response, "params");
      await findSession(response);
      await agentLoop.withSessionScopeMaintenance(sessionId, async () => {
        await agentLoop.cancelBySession(sessionId);
        await processSupervisor.stopByOwner({ type: "session", id: sessionId });
        await workspaceStore.deleteSession(currentOwnerId(response), sessionId);
        await storedFiles.cleanupOrphans();
      });
      response.status(204).send();
    },

    async getSessionContext(_request: Request, response: Response): Promise<void> {
      const session = await findSession(response);
      response.json({
        session_id: session.id,
        responses: workspaceStore.listResponses(session.id).map((run) => toAgentResponseDto(run, storedFiles.describeForSession.bind(storedFiles))),
        context: {
          last_input_tokens: session.contextState?.lastInputTokens,
          summarized_run_count: session.contextState?.summarizedRunCount ?? 0,
          compressions: session.compressionRecords.map((record) => ({
            summarized_run_count: record.summarizedRunCount, summary: record.summary, created_at: record.createdAt,
          })),
        },
      });
    },

    async compactSession(_request: Request, response: Response): Promise<void> {
      const session = await findSession(response);
      const body = validated<CompactSessionBody>(response, "body");
      const compressed = await agentLoop.withIdleSessionScopeMaintenance(session.id, () => agentLoop.compact(
        session, body.model, body.reasoningEffort,
      ));
      response.json({ compressed, summarized_run_count: session.contextState?.summarizedRunCount ?? 0 });
    },

    async createResponse(request: Request, response: Response): Promise<void> {
      const session = await findSession(response);
      const body = validated<CreateResponseBody>(response, "body");
      const normalizedInput = await normalizeWorkspaceFileReferences(session, body.input);
      storedFiles.validateResponseFiles(session.id, normalizedInput.flatMap((message) =>
        message.content.flatMap((part) => part.type === "input_file" ? [part.file_id] : []),
      ));
      const stream = body.stream === true || acceptsEventStream(request);
      const run = async (onEvent?: AgentStreamEventHandler) => toAgentResponseDto(await agentLoop.run(
        session,
        inputFromDto(normalizedInput),
        {
          model: body.model,
          ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
          permissionMode: body.permissionMode,
        },
        toDomainHandler(onEvent),
      ), storedFiles.describeForSession.bind(storedFiles));
      if (stream) return streamRun(response, run, logger);
      response.status(201).json(await run());
    },

    async getResponse(_request: Request, response: Response): Promise<void> {
      const session = await findSession(response);
      const { responseId } = validated<ResponseParams>(response, "params");
      const agentResponse = workspaceStore.getResponse(session.id, responseId);
      if (!agentResponse) throw new ApiError(404, "response_not_found", "Response not found.");
      response.json(toAgentResponseDto(agentResponse, storedFiles.describeForSession.bind(storedFiles)));
    },

    async cancelResponse(_request: Request, response: Response): Promise<void> {
      const session = await findSession(response);
      const { responseId } = validated<ResponseParams>(response, "params");
      const agentResponse = workspaceStore.getResponse(session.id, responseId);
      if (!agentResponse) throw new ApiError(404, "response_not_found", "Response not found.");
      response.json(toAgentResponseDto(await agentLoop.cancel(session, agentResponse), storedFiles.describeForSession.bind(storedFiles)));
    },

    async resolvePermissions(request: Request, response: Response): Promise<void> {
      const session = await findSession(response);
      const { responseId } = validated<ResponseParams>(response, "params");
      const body = validated<ResolvePermissionsBody>(response, "body");
      const agentResponse = workspaceStore.getResponse(session.id, responseId);
      if (!agentResponse) throw new ApiError(404, "response_not_found", "Response not found.");
      const run = async (onEvent?: AgentStreamEventHandler) => toAgentResponseDto(await agentLoop.resolvePermissions(
        session,
        agentResponse,
        body.batchId,
        body.decisions.map((decision) => ({
          permissionId: decision.permission_id,
          decision: decision.decision,
          ...(decision.decision === "deny" && decision.reason ? { reason: decision.reason } : {}),
        })),
        toDomainHandler(onEvent),
      ), storedFiles.describeForSession.bind(storedFiles));
      if (acceptsEventStream(request)) return streamRun(response, run, logger);
      response.json(await run());
    },
  };

  function toDomainHandler(handler: AgentStreamEventHandler | undefined): AgentDomainEventHandler | undefined {
    if (!handler) return undefined;
    const streamProjector = new AgentStreamProjector(storedFiles.describeForSession.bind(storedFiles));
    return async (run, event) => {
      for (const projected of streamProjector.project(run, event)) await handler(projected);
    };
  }

  async function findSession(response: Response): Promise<Session> {
    const { sessionId } = validated<SessionParams>(response, "params");
    const session = await workspaceStore.getSession(sessionId, currentOwnerId(response));
    if (!session) throw new ApiError(404, "session_not_found", "Session not found.");
    return session;
  }

  async function normalizeWorkspaceFileReferences(
    session: Session,
    input: ResponseInputMessageDto[],
  ): Promise<ResponseInputMessageDto[]> {
    const hasReferences = input.some((message) =>
      message.content.some((part) => part.type === "input_workspace_file"));
    if (!hasReferences) return input;
    if (!session.cwd) {
      throw new ApiError(400, "workspace_file_requires_project", "Workspace file references require a Project-bound Session.");
    }

    const normalized = structuredClone(input);
    for (const [messageIndex, message] of normalized.entries()) {
      for (const [contentIndex, part] of message.content.entries()) {
        if (part.type !== "input_workspace_file") continue;
        try {
          part.path = await workspaceFiles.validateReference(session.cwd, part.path);
        } catch {
          throw new ApiError(400, "invalid_workspace_file", "Workspace file reference is invalid.", {
            source: "body",
            issues: [{
              path: ["input", messageIndex, "content", contentIndex, "path"],
              code: "invalid_workspace_file",
              message: "Path must identify an existing regular file inside the current Project without traversing symbolic links.",
            }],
          });
        }
      }
    }
    return normalized;
  }
}

function acceptsEventStream(request: Request): boolean {
  return (request.get("accept") ?? "").split(",").some((value) => value.trim().split(";", 1)[0] === "text/event-stream");
}

async function streamRun(response: Response, run: (handler: AgentStreamEventHandler) => Promise<unknown>, logger: Logger): Promise<void> {
  response.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  let connected = true;
  response.once("close", () => { connected = false; });

  // Periodic keep-alive comments prevent proxies, load-balancers and clients
  // from closing the connection during long model or tool calls.
  const keepAliveTimer = setInterval(() => {
    response.write(":keep-alive\n\n");
  }, SSE_KEEPALIVE_INTERVAL_MS);

  try {
    await run((event) => {
      if (connected && !response.destroyed && !response.writableEnded) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.status === 500) {
      logger.error({ event: "http.sse.failed", statusCode: apiError.status, errorCode: apiError.code, ...errorFields(error) });
    }
    if (connected && !response.destroyed && !response.writableEnded) {
      response.write(`event: error\ndata: ${JSON.stringify(toApiErrorBody(apiError))}\n\n`);
    }
  } finally {
    clearInterval(keepAliveTimer);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}
