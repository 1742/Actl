import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AgentCommand } from '../shared/agent-ipc';
import type { SessionReview } from '../shared/agent/review';
import { reviewDiff } from '../agent-core/runtime/review-diff';
import type { AppDependencies } from '../agent-core/app/dependencies';
import type { Session } from '../agent-core/runtime/workspace-store';
import type { AgentDomainEventHandler } from '../agent-core/runtime/agent-domain';
import { toProjectJson, toSessionJson } from '../agent-core/contracts/common/presenters';
import { ApiError } from '../agent-core/contracts/common/api-error';
import { inputFromDto, toAgentResponseDto } from '../agent-core/contracts/agent-responses/presenter';
import type { AgentStreamEvent, ResponseInputMessageDto } from '../shared/agent/responses';
import type { SessionContext } from '../shared/agent/sessions';
import type { RuntimeStoredFile } from '../shared/agent/files';
import type { RuntimeProviderAccount } from '../shared/agent/models';
import type { RuntimeSkillCatalog, SkillDetail } from '../shared/agent/skills';
import * as sessions from '../agent-core/contracts/sessions/session.schemas';
import * as projects from '../agent-core/contracts/projects/project.schemas';
import * as models from '../agent-core/contracts/models/model.schemas';
import * as accounts from '../agent-core/contracts/provider-accounts/provider-account.schemas';
import * as skills from '../agent-core/contracts/skills/skill.schemas';
import { storedFileParamsSchema } from '../agent-core/contracts/stored-files/stored-file.schemas';
import { findModelCompatibilityIssues } from '../agent-core/model/compatibility';
import { TEXT_TOOL_CAPABILITIES } from '../agent-core/runtime/model-store';
import { createDefaultPromptSettings } from '../agent-core/runtime/prompt-compiler';
import { isPathInside } from '../agent-core/tools/path-security';
import { serverNameSchema, serverSchema } from '../agent-core/mcp/mcp-config';
import { MAX_STORED_FILE_BYTES } from '../agent-core/stored-files/stored-file-service';
import { toCatalogDto, listSkillFiles, inferLanguages } from '../agent-core/contracts/skills/presenter';

const ownerId = 'developer:local';
const promptSchema = z.object({
  revision: z.number().int().min(0),
  blocks: z.array(z.object({
    id: z.string().min(1).max(100), title: z.string().trim().min(1).max(80),
    text: z.string().max(30_000), enabled: z.boolean(),
  }).strict()).max(40),
}).strict().superRefine(({ blocks }, ctx) => {
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) ctx.addIssue({ code: 'custom', message: 'Block IDs must be unique.' });
  if (blocks.reduce((sum, block) => sum + block.text.length, 0) > 120_000) ctx.addIssue({ code: 'custom', message: 'Prompt text is too large.' });
});
const searchSchema = z.object({
  enabled: z.boolean(), provider: z.enum(['brave', 'tavily', 'serper', 'bocha']).optional(),
  mode: z.enum(['auto', 'native', 'external']).optional(), baseUrl: z.url().optional(), apiKey: z.string().trim().min(1).optional(),
}).strict();
const fileSchema = z.object({
  filename: z.string().min(1).max(1_024), mediaType: z.string().max(255),
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength <= MAX_STORED_FILE_BYTES),
}).strict();

export class AgentApplication {
  constructor(readonly dependencies: AppDependencies) {}

  async invoke(command: AgentCommand, onEvent?: (event: AgentStreamEvent) => void): Promise<unknown> {
    const d = this.dependencies;
    const params = command.params ?? {};
    const query = command.query ?? {};
    const body = command.body;
    const sessionId = () => sessions.sessionParamsSchema.parse(params).sessionId;
    const projectId = () => projects.projectParamsSchema.parse(params).projectId;
    const workspaceDirectory = () => {
      const input = projects.workspaceParamsSchema.parse(params);
      return this.workspaceDirectory(input.projectId, input.workspaceId);
    };
    const accountId = () => accounts.providerAccountParamsSchema.parse(params).accountId;
    const modelId = () => models.modelParamsSchema.parse(params).modelTargetId;
    switch (command.operation) {
      case 'agents.tree':
      case 'agents.watch': return d.agentCoordinator.snapshot(await this.session(sessionId()));
      case 'agents.message': {
        const sender = await this.session(sessionId());
        const input = z.object({ targetSessionId: z.string().min(1), message: z.string().trim().min(1).max(16000) }).strict().parse(body);
        const run = sender.runs.at(-1);
        if (!run) throw new ApiError(400, 'agent_run_required', 'Send an initial task before messaging agents.');
        d.agentCoordinator.allowUserTurn(sender);
        return d.agentCoordinator.send(sender, run, input.targetSessionId, `User follow-up: ${input.message}`, crypto.randomUUID());
      }
      case 'agents.stop': {
        await d.agentCoordinator.stopTree(await this.session(sessionId()));
        return;
      }
      case 'runtime.info': return { mode: d.modelStore.mode, ownerId, modelConfigurationEnabled: true };
      case 'projects.list': return d.workspaceStore.listProjects(ownerId).map(toProjectJson);
      case 'projects.create': {
        const input = projects.createProjectBodySchema.parse(body);
        return toProjectJson(await d.workspaceStore.createProject(ownerId, input));
      }
      case 'projects.update': {
        const id = projectId(); this.project(id);
        const input = projects.updateProjectBodySchema.parse(body);
        return toProjectJson(await d.agentLoop.withIdleProjectScopeMaintenance(id, ownerId,
          () => d.workspaceStore.updateProject(ownerId, id, input)));
      }
      case 'projects.delete': {
        const id = projectId(); this.project(id);
        await d.agentLoop.withProjectScopeMaintenance(id, async () => {
          const ids = d.workspaceStore.listSessions(ownerId, id).map((session) => session.id);
          const roots = d.workspaceStore.listSessions(ownerId, id).filter((session) => !session.parentSessionId);
          await Promise.all(roots.map((session) => d.agentCoordinator.stopTree(session)));
          await Promise.all(ids.map((id) => d.processSupervisor.stopByOwner({ type: 'session', id })));
          await d.workspaceStore.deleteProject(ownerId, id);
          await d.storedFiles.cleanupOrphans();
        });
        return;
      }
      case 'workspace.search': {
        const directory = workspaceDirectory();
        const input = projects.searchProjectFilesQuerySchema.parse(query);
        return d.workspaceFiles.searchQuery(directory, input.q, input.limit);
      }
      case 'workspace.searchProject': {
        const project = this.project(projectId());
        const { q, limit } = projects.searchProjectFilesQuerySchema.parse(query);
        return d.workspaceFiles.searchProject(project.workspaces, q, limit);
      }
      case 'workspace.tree': {
        const directory = workspaceDirectory();
        const input = projects.listProjectDirectoryQuerySchema.parse(query);
        return d.workspaceFiles.listDirectory(directory, input);
      }
      case 'workspace.preview': {
        const directory = workspaceDirectory();
        const input = projects.previewProjectFileQuerySchema.parse(query);
        return d.workspaceFiles.previewFile(directory, input.path);
      }
      case 'workspace.revealTarget': {
        const directory = workspaceDirectory();
        const input = projects.previewProjectFileQuerySchema.parse(query);
        return d.workspaceFiles.resolveFileForReveal(directory, input.path);
      }
      case 'workspace.projectDirectory': return workspaceDirectory();
      case 'sessions.list': {
        const input = sessions.listSessionsQuerySchema.parse(query);
        return d.workspaceStore.listSessions(ownerId, input.scope === 'standalone' ? null : input.projectId).map(toSessionJson);
      }
      case 'sessions.create': {
        const input = sessions.createSessionBodySchema.parse(body);
        return toSessionJson(await d.workspaceStore.createSession(ownerId, {
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.title === undefined ? {} : { title: input.title }),
        }));
      }
      case 'sessions.rename': {
        const input = sessions.updateSessionBodySchema.parse(body);
        return toSessionJson(await d.workspaceStore.updateSession(ownerId, sessionId(), input.title ?? undefined));
      }
      case 'sessions.delete': {
        const id = sessionId(); await this.session(id);
        await d.agentLoop.withSessionScopeMaintenance(id, async () => {
          await d.agentCoordinator.stopTree(await this.session(id));
          await d.workspaceStore.deleteSession(ownerId, id);
          await d.storedFiles.cleanupOrphans();
        });
        return;
      }
      case 'sessions.review': {
        const session = await this.session(sessionId());
        const { fileId, runId } = z.object({
          fileId: z.string().max(128).optional(),
          runId: z.string().max(128).optional(),
        }).strict().parse(query);
        const run = session.runs.findLast((item) =>
          item.completedAt !== undefined && (runId === undefined || item.id === runId),
        );
        const review: SessionReview = { runId: run?.id ?? null, files: [] };
        if (!run) return review;
        for (const change of session.fileChanges) {
          if (change.runId !== run.id) continue;
          const before = change.changeType === 'create' ? '' : change.oldContent;
          const after = change.newContent;
          const unavailable = before === undefined || after === undefined;
          if (!unavailable && before === after && change.changeType !== 'create') continue;
          const diff = unavailable ? undefined : reviewDiff(before, after, change.id === fileId);
          const reviewPath = session.cwd && path.isAbsolute(change.filePath) && isPathInside(session.cwd, change.filePath)
            ? path.relative(session.cwd, change.filePath) : change.filePath;
          review.files.push({
            id: change.id, path: reviewPath.replaceAll('\\', '/'), unavailable,
            additions: diff?.additions ?? 0, deletions: diff?.deletions ?? 0,
          });
          if (change.id === fileId && diff) review.lines = diff.lines;
        }
        return review;
      }
      case 'sessions.context': {
        const session = await this.session(sessionId());
        return {
          session_id: session.id, responses: d.workspaceStore.listResponses(session.id).map((run) => this.responseDto(run)),
          context: {
            last_input_tokens: session.contextState?.lastInputTokens,
            summarized_run_count: session.contextState?.summarizedRunCount ?? 0,
            compressions: session.compressionRecords.map((record) => ({ summarized_run_count: record.summarizedRunCount, summary: record.summary, created_at: record.createdAt })),
          },
        } satisfies SessionContext;
      }
      case 'sessions.compact': {
        const session = await this.session(sessionId()); const input = sessions.compactSessionBodySchema.parse(body);
        const compressed = await d.agentLoop.withIdleSessionScopeMaintenance(session.id, () => d.agentLoop.compact(session, input.model, input.reasoningEffort));
        return { compressed, summarized_run_count: session.contextState?.summarizedRunCount ?? 0 };
      }
      case 'responses.create': {
        const session = await this.session(sessionId()); const input = sessions.createResponseBodySchema.parse(body);
        d.agentCoordinator.allowUserTurn(session);
        const prepareInput = async () => {
          const normalized = await this.normalizeReferences(session, input.input);
          d.storedFiles.validateResponseFiles(session.id, normalized.flatMap((message) => message.content.flatMap((part) => part.type === 'input_file' ? [part.file_id] : [])));
          return inputFromDto(normalized);
        };
        return this.responseDto(await d.agentLoop.run(session, prepareInput, {
          model: input.model, permissionMode: input.permissionMode, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        }, this.projectEvents(onEvent)));
      }
      case 'responses.permissions': {
        const ids = sessions.responseParamsSchema.parse(params); const session = await this.session(ids.sessionId);
        const run = this.response(session, ids.responseId); const input = sessions.resolvePermissionsBodySchema.parse(body);
        return this.responseDto(await d.agentLoop.resolvePermissions(session, run, input.batchId, input.decisions.map((decision) => ({
          permissionId: decision.permission_id, decision: decision.decision,
          ...(decision.decision === 'deny' && decision.reason ? { reason: decision.reason } : {}),
        })), this.projectEvents(onEvent)));
      }
      case 'responses.cancel': {
        const ids = sessions.responseParamsSchema.parse(params); const session = await this.session(ids.sessionId);
        const run = this.response(session, ids.responseId);
        if (run.status === 'cancelled') return this.responseDto(run);
        if (run.status !== 'in_progress' && run.status !== 'waiting_permission') {
          throw new ApiError(409, 'response_not_cancellable', 'Response is no longer active.');
        }
        await d.agentCoordinator.stopTree(session);
        return this.responseDto(run);
      }
      case 'files.upload': {
        const id = sessionId(); await this.session(id);
        return this.fileDto(await d.storedFiles.upload(id, fileSchema.parse(body)));
      }
      case 'files.content': {
        const ids = storedFileParamsSchema.parse(params); await this.session(ids.sessionId);
        const content = d.storedFiles.contentPath(ids.sessionId, ids.fileId);
        return { bytes: new Uint8Array(await readFile(content.path)), mediaType: content.file.mediaType };
      }
      case 'accounts.list': return { data: d.modelStore.listProviderAccounts(ownerId) };
      case 'accounts.create': return this.accountDto(await d.modelStore.createProviderAccount(ownerId, accounts.createProviderAccountBodySchema.parse(body)));
      case 'accounts.update': {
        const input = accounts.editProviderAccountBodySchema.parse(body);
        return this.accountDto(await d.modelStore.updateProviderAccount(ownerId, accountId(), {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        }));
      }
      case 'accounts.delete': return d.modelStore.deleteProviderAccount(ownerId, accountId());
      case 'accounts.credential.replace': return d.modelStore.replaceCredential(ownerId, accountId(), accounts.replaceCredentialBodySchema.parse(body).apiKey);
      case 'accounts.credential.clear': return d.modelStore.clearCredential(ownerId, accountId());
      case 'models.list': {
        const input = models.listModelsQuerySchema.parse(query); const catalog = await d.modelStore.list(ownerId);
        if (!input.sessionId) return catalog;
        const session = await this.session(input.sessionId); const history = d.workspaceStore.getModelContext(session);
        return { ...catalog, data: await Promise.all(catalog.data.map(async (model) => {
          const transcript = await d.storedFiles.materializeTranscript(session.id, history, model.capabilities);
          const reasons = findModelCompatibilityIssues(transcript, model.capabilities);
          return { ...model, compatible: reasons.length === 0, incompatibilityReasons: reasons };
        })) };
      }
      case 'models.create': {
        const input = models.createModelBodySchema.parse(body);
        return d.modelStore.createModelTarget(ownerId, accountId(), { ...input, capabilities: input.capabilities ?? structuredClone(TEXT_TOOL_CAPABILITIES) });
      }
      case 'models.update': {
        const input = models.editModelBodySchema.parse(body);
        return d.modelStore.updateModelTarget(ownerId, modelId(), {
          ...(input.providerModel !== undefined ? { providerModel: input.providerModel } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
          ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        });
      }
      case 'models.delete': return d.modelStore.deleteModelTarget(ownerId, modelId());
      case 'models.preference': {
        const input = models.modelPreferenceBodySchema.parse(body);
        return d.modelStore.setPreference(ownerId, input.modelTargetId ?? undefined, input.reasoningEffort ?? undefined);
      }
      case 'prompts.get': return d.promptSettingsRepository.getPromptSettings(ownerId) ?? createDefaultPromptSettings();
      case 'prompts.defaults': return createDefaultPromptSettings();
      case 'prompts.save': {
        const input = promptSchema.parse(body); const saved = d.promptSettingsRepository.savePromptSettings(ownerId, input.revision, input.blocks);
        if (!saved) throw new ApiError(409, 'prompt_settings_conflict', 'Prompt settings changed. Reload and try again.');
        return saved;
      }
      case 'search.get': return d.webSearchService.getSettings(ownerId);
      case 'search.save': {
        const input = searchSchema.parse(body);
        return d.webSearchService.configure(ownerId, {
          enabled: input.enabled, ...(input.provider ? { provider: input.provider } : {}), ...(input.mode ? { mode: input.mode } : {}),
          ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        });
      }
      case 'search.clear': return d.webSearchService.clearCredential(ownerId);
      case 'search.test': return d.webSearchService.test(ownerId);
      case 'mcp.list': return { servers: d.mcpManager.listServers() };
      case 'mcp.catalog': return { servers: await d.mcpManager.listCatalog() };
      case 'mcp.save': {
        const name = serverNameSchema.parse(params.name); const config = serverSchema.parse(body);
        try { return await d.mcpManager.saveServer(name, config); }
        catch (error) {
          if (error instanceof Error && error.message.includes('collides')) throw new ApiError(409, 'mcp_name_collision', error.message);
          throw error;
        }
      }
      case 'mcp.delete': {
        const name = serverNameSchema.parse(params.name);
        try { return await d.mcpManager.deleteServer(name); }
        catch (error) {
          if (error instanceof Error && error.message.includes('does not exist')) throw new ApiError(404, 'mcp_server_not_found', error.message);
          throw error;
        }
      }
      case 'mcp.test': {
        const input = z.object({ name: serverNameSchema, config: serverSchema }).strict().parse(body);
        try { return await d.mcpManager.testServer(input.name, input.config); }
        catch (error) { throw new ApiError(422, 'mcp_connection_failed', error instanceof Error ? error.message : String(error)); }
      }
      case 'skills.list': {
        const input = skills.listSkillsQuerySchema.parse(query); const cwd = await this.skillCwd(input);
        const page = await d.skillCatalog.listSkillSummaries(cwd, {
          ...(input.q !== undefined ? { query: input.q } : {}), ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.page !== undefined ? { page: input.page } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        return { ...page, data: page.data.map(toCatalogDto) } satisfies RuntimeSkillCatalog;
      }
      case 'skills.detail': {
        const input = skills.listSkillsQuerySchema.parse(query); const { skillId } = skills.skillParamsSchema.parse(params);
        const skill = await d.skillCatalog.findSkill(skillId, await this.skillCwd(input));
        if (!skill) throw new ApiError(404, 'skill_not_found', 'Skill not found.');
        const entries = skill.package ? await listSkillFiles(skill.package.rootPath) : [];
        return { ...toCatalogDto(skill), ...(skill.package ? {
          manifest: structuredClone(skill.package.manifest), languages: inferLanguages(entries), content_digest: skill.package.contentDigest,
          files: { root: skill.package.rootPath, skill: skill.package.skillFilePath, entries },
        } : {}) } satisfies SkillDetail;
      }
      default: throw new ApiError(400, 'invalid_operation', 'Unsupported Agent operation.');
    }
  }

  async close(drain?: () => Promise<void>): Promise<void> {
    const d = this.dependencies;
    await d.agentCoordinator.close();
    await drain?.();
    const cleanup = await Promise.allSettled([d.processSupervisor.dispose(), d.mcpManager.close()]);
    try { await d.storedFiles.cleanupOrphans(); }
    finally { d.closeDatabase(); }
    const failed = cleanup.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private project(id: string) {
    const project = this.dependencies.workspaceStore.getProject(id, ownerId);
    if (!project) throw new ApiError(404, 'project_not_found', 'Project not found.');
    return project;
  }
  private workspaceDirectory(projectId: string, workspaceId?: string) {
    const project = this.project(projectId);
    if (workspaceId === undefined) return project.cwd;
    const workspace = project.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new ApiError(404, 'workspace_not_found', 'Workspace does not belong to this project.');
    return workspace.path;
  }
  private async session(id: string) {
    const session = await this.dependencies.workspaceStore.getSession(id, ownerId);
    if (!session) throw new ApiError(404, 'session_not_found', 'Session not found.');
    return session;
  }
  private response(session: Session, id: string) {
    const run = this.dependencies.workspaceStore.getResponse(session.id, id);
    if (!run) throw new ApiError(404, 'response_not_found', 'Response not found.');
    return run;
  }
  private responseDto(run: Parameters<typeof toAgentResponseDto>[0]) {
    return toAgentResponseDto(run, this.dependencies.storedFiles.describeForSession.bind(this.dependencies.storedFiles));
  }
  private accountDto(account: Awaited<ReturnType<AppDependencies['modelStore']['createProviderAccount']>>): RuntimeProviderAccount {
    return { id: account.id, displayName: account.displayName, baseURL: account.baseURL, enabled: account.enabled,
      hasCredential: account.credentialVersion !== null, createdAt: account.createdAt, updatedAt: account.updatedAt };
  }
  private fileDto(file: Awaited<ReturnType<AppDependencies['storedFiles']['upload']>>): RuntimeStoredFile {
    return { id: file.id, object: 'stored_file', session_id: file.sessionId, filename: file.filename,
      media_type: file.mediaType, size: file.size, created_at: file.createdAt };
  }
  private projectEvents(onEvent: ((event: AgentStreamEvent) => void) | undefined): AgentDomainEventHandler | undefined {
    if (!onEvent) return undefined;
    return async (run, event) => { for (const projected of this.dependencies.agentCoordinator.events.project(run, event)) onEvent(structuredClone(projected)); };
  }
  private async skillCwd(input: { sessionId?: string | undefined; projectId?: string | undefined }) {
    if (input.sessionId) return (await this.session(input.sessionId)).cwd;
    if (input.projectId) return this.project(input.projectId).cwd;
    return null;
  }
  private async normalizeReferences(session: Session, input: ResponseInputMessageDto[]) {
    const normalized = structuredClone(input);
    for (const message of normalized) for (const part of message.content) {
      if (part.type !== 'input_workspace_file') continue;
      if (!session.projectId || !session.cwd) throw new ApiError(400, 'workspace_file_requires_project', 'Workspace file references require a Project-bound Session.');
      const directory = this.workspaceDirectory(session.projectId, part.workspaceId);
      try {
        const file = await this.dependencies.workspaceFiles.validateReference(directory, part.path);
        part.path = file.split(path.sep).join('/');
      }
      catch { throw new ApiError(400, 'invalid_workspace_file', 'Workspace file reference is invalid.'); }
    }
    return normalized;
  }
}
