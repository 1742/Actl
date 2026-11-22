import fs from 'node:fs';
import path from "node:path";
import { z } from "zod";
import type { ProcessSandbox, SessionProcessAccess } from "../../runtime/process/process-types.js";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
  type ToolProvider,
} from "../registry.js";
import { canonicalizePotentialPath, toolBaseDirectory } from "../path-security.js";

const DEFAULT_YIELD_TIME_MS = 10_000;
const MAX_WAIT_MS = 120_000;

interface ResolvedShellCommand {
  command: string;
  cwd: string;
  resource: string;
  yieldTimeMs?: number;
  env: NodeJS.ProcessEnv;
  sandbox?: ProcessSandbox;
}

const nonEmptyStringSchema = z.string().trim().min(1);
export const shellInputSchema = z.object({
  command: nonEmptyStringSchema.describe("Shell command to execute."),
  hostAccessReason: nonEmptyStringSchema.optional().describe("For root sessions in ask, accept_edits, or full_access. Request host permissions for this command and explain why it requires access beyond the workspace-write sandbox. Requires approval in accept_edits."),
  cwd: nonEmptyStringSchema.optional().describe("Optional absolute path or path relative to the Session cwd."),
  yieldTimeMs: z.number().int().min(0).max(MAX_WAIT_MS).optional()
    .describe("Wait up to this many milliseconds for the command to exit before returning control. The process keeps running if the wait expires. Default: 10000; maximum: 120000."),
}).strict();
export const shellPollInputSchema = z.object({
  processId: nonEmptyStringSchema.describe("Logical process ID returned by shell."),
  cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
    .describe("Return output after this cursor. Omit to read retained output from the beginning."),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
    .describe("Return output beginning at this 1-based line number across both streams in arrival order. Mutually exclusive with cursor; nextLine in the result is the next line to request."),
  waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional()
    .describe("Wait up to this many milliseconds before returning. Maximum: 120000."),
  waitForExit: z.boolean().optional()
    .describe("When true, wait for process exit or waitMs expiry even if output arrives. Use for builds and other commands whose final exit code matters."),
}).strict().refine((input) => input.cursor === undefined || input.line === undefined, {
  message: "cursor and line cannot be used together.",
});
export const shellStopInputSchema = z.object({
  processId: nonEmptyStringSchema.describe("Logical process ID returned by shell."),
  cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
    .describe("Return output after this cursor. Pass the latest nextCursor to avoid repeated output; omit to read retained output from the beginning."),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
    .describe("Return output beginning at this 1-based line number across both streams in arrival order. Mutually exclusive with cursor; nextLine in the result is the next line to request."),
}).strict().refine((input) => input.cursor === undefined || input.line === undefined, {
  message: "cursor and line cannot be used together.",
});

type ShellInput = z.infer<typeof shellInputSchema>;
type ShellPollInput = z.infer<typeof shellPollInputSchema>;
type ShellStopInput = z.infer<typeof shellStopInputSchema>;

export interface ShellRuntime {
  platform: NodeJS.Platform;
  executable: string;
  description: string;
}

export class ShellToolProvider implements ToolProvider {
  readonly name = "builtin-shell";

  async listTools(): Promise<ToolDefinition[]> {
    const runtime = getShellRuntime();
    return [
      {
        name: "shell",
        description: `Run a shell command. Plan mode uses the Windows read-only sandbox. Outside plan, subagents use the workspace-write sandbox. In a root session, accept_edits uses the workspace-write sandbox and hostAccessReason requests a wider scope on a new call. Check partial effects before retrying. Use shell_poll and shell_stop for background processes. Current shell: ${runtime.description}`,
        inputSchema: shellInputSchema,
      },
      {
        name: "shell_poll",
        description: "Read output and status from a shell process owned by the current session. Supply cursor for incremental chunks or line to read from a 1-based line number. Use waitMs with waitForExit to wait for completion without waking on each log line. Check status first: exitCode indicates command success or failure only when status is exited.",
        inputSchema: shellPollInputSchema,
        execution: { concurrency: "parallel" },
      },
      {
        name: "shell_stop",
        description: "Stop a shell process owned by the current session, including its process tree. Pass cursor to return only unread chunks or line to read from a 1-based line number. A stopped result means termination was requested; its exitCode may be nonzero and does not mean the command failed on its own.",
        inputSchema: shellStopInputSchema,
      },
    ];
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    if (name === "shell") {
      const resolved = await this.resolveCommand(input, context);
      return {
        capability: shellSpawnCapability(resolved.sandbox),
        resource: resolved.resource,
        action: "execute",
      };
    }
    if (name === "shell_poll" || name === "shell_stop") {
      const processes = this.requireProcesses(context);
      const processId = name === "shell_poll"
        ? (input as ShellPollInput).processId
        : (input as ShellStopInput).processId;
      if (!processes.owns(processId)) throw new Error("process_not_found");
      return {
        capability: name === "shell_poll" ? "process.read" : shellStopCapability(context, processes, processId),
        resource: processId,
        action: name === "shell_poll" ? "read" : "terminate",
      };
    }
    throw new Error(`Unsupported builtin tool: ${name}`);
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    const runtime = getShellRuntime();
    if (name === "shell") {
      const resolved = await this.resolveCommand(input, context);
      this.assertAuthorization(context, shellSpawnCapability(resolved.sandbox), "execute", resolved.resource);
      if (!resolved.sandbox && context.permissionMode === 'accept_edits' && !context.authorization?.approvedByUser) {
        throw new Error("Host shell execution requires approval for this call.");
      }
      const shell = runtime.platform === "win32" ? resolvePowerShell() : runtime.executable;
      const processes = this.requireProcesses(context);
      const started = await processes.start({
        command: resolved.command,
        cwd: resolved.cwd,
        shell,
        ...(resolved.sandbox ? { sandbox: resolved.sandbox } : {}),
        outputEncoding: "utf8",
        env: resolved.env,
        startupWaitMs: resolved.yieldTimeMs ?? DEFAULT_YIELD_TIME_MS,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (context.signal?.aborted) {
        await processes.stop({ processId: started.processId });
        context.signal.throwIfAborted();
      }
      return started;
    }
    if (name === "shell_poll") {
      const parsed = input as ShellPollInput;
      this.assertAuthorization(context, "process.read", "read", parsed.processId);
      return this.requireProcesses(context).poll({
        processId: parsed.processId,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        ...(parsed.line === undefined ? {} : { line: parsed.line }),
        ...(parsed.waitMs === undefined ? {} : { waitMs: parsed.waitMs }),
        ...(parsed.waitForExit === undefined ? {} : { waitForExit: parsed.waitForExit }),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    }
    if (name === "shell_stop") {
      const parsed = input as ShellStopInput;
      const processes = this.requireProcesses(context);
      this.assertAuthorization(context, shellStopCapability(context, processes, parsed.processId), "terminate", parsed.processId);
      return processes.stop({
        processId: parsed.processId,
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        ...(parsed.line === undefined ? {} : { line: parsed.line }),
      });
    }
    throw new Error(`Unsupported builtin tool: ${name}`);
  }

  private async resolveCommand(
    input: unknown,
    context: ToolCallContext,
  ): Promise<ResolvedShellCommand> {
    const parsed = input as ShellInput;
    this.requireProcesses(context);
    if (parsed.hostAccessReason) {
      if (context.isSubagent) throw new Error("Subagents cannot request host shell access.");
      if (context.permissionMode === 'plan') throw new Error("Plan mode requires the Windows read-only shell sandbox. Omit hostAccessReason.");
    }

    const baseDirectory = toolBaseDirectory(context.cwd);
    const candidateCwd = parsed.cwd
      ? path.isAbsolute(parsed.cwd) ? parsed.cwd : path.resolve(baseDirectory, parsed.cwd)
      : baseDirectory;
    const resolvedCwd = await canonicalizePotentialPath(candidateCwd);

    const shell = getShellRuntime().executable;
    let resource = JSON.stringify({ shell, cwd: resolvedCwd, command: parsed.command });
    let sandbox: ProcessSandbox | undefined;
    if (context.permissionMode === 'plan') {
      sandbox = { mode: 'read-only' };
      resource = JSON.stringify({ shell, command: parsed.command, cwd: resolvedCwd, access: 'read-only' });
    } else if (context.isSubagent || (context.permissionMode === 'accept_edits' && !parsed.hostAccessReason)) {
      if (!context.cwd || process.platform !== 'win32') {
        const guidance = context.isSubagent ? '' : ' Request hostAccessReason for an approved host command.';
        throw new Error(`A Windows session workspace is required for confined shell execution.${guidance}`);
      }
      const workspaceRoot = await canonicalizePotentialPath(context.cwd);
      sandbox = { mode: 'workspace-write', workspaceRoot };
      resource = JSON.stringify({ shell, command: parsed.command, cwd: resolvedCwd, workspace: workspaceRoot });
    } else if (parsed.hostAccessReason) {
      resource = JSON.stringify({ shell, command: parsed.command, cwd: resolvedCwd, access: 'host', reason: parsed.hostAccessReason });
    }
    return {
      command: parsed.command,
      cwd: resolvedCwd,
      env: { ...process.env },
      resource,
      ...(sandbox ? { sandbox } : {}),
      ...(parsed.yieldTimeMs === undefined ? {} : { yieldTimeMs: parsed.yieldTimeMs }),
    };
  }

  private requireProcesses(context: ToolCallContext): SessionProcessAccess {
    if (!context.processes) throw new Error("Shell tools require session process access.");
    return context.processes;
  }

  private assertAuthorization(context: ToolCallContext, capability: string, action: string, resource: string): void {
    const requirement = context.authorization?.requirement;
    if (!requirement || requirement.capability !== capability || requirement.action !== action || requirement.resource !== resource) {
      throw new Error("Shell tool does not have authorization for this operation.");
    }
  }
}

function shellSpawnCapability(sandbox: ProcessSandbox | undefined): string {
  if (!sandbox) return "process.spawn";
  return sandbox.mode === 'read-only' ? "process.spawn.readonly" : "process.spawn.workspace";
}

function shellStopCapability(context: ToolCallContext, processes: SessionProcessAccess, processId: string): string {
  if (context.isSubagent || (context.permissionMode === 'plan' && processes.owns(processId, 'read-only'))) {
    return "process.terminate.sandboxed";
  }
  return "process.terminate";
}

export function getShellRuntime(platform: NodeJS.Platform = process.platform): ShellRuntime {
  if (platform === "win32") {
    return {
      platform,
      executable: "pwsh.exe",
      description: "PowerShell 7 (pwsh.exe). Use PowerShell syntax, including $env:NAME for environment variables.",
    };
  }
  return { platform, executable: "/bin/sh", description: "POSIX /bin/sh. Use POSIX shell syntax and commands (for example ls)." };
}

export function resolvePowerShell(environment = process.env): string {
  const directories = (environment.PATH ?? '').split(path.delimiter)
    .map(directory => directory.trim().replace(/^"|"$/g, '')).filter(directory => path.isAbsolute(directory));
  if (environment.ProgramFiles) directories.push(path.join(environment.ProgramFiles, 'PowerShell', '7'));
  const checked: string[] = [];
  for (const directory of new Set(directories)) {
    const executable = path.join(directory, 'pwsh.exe');
    try {
      if (fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) return executable;
      checked.push(executable);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
      checked.push(`${executable} (${code})`);
    }
  }
  throw new Error(`PowerShell 7 (pwsh.exe) was not found. Install PowerShell 7 or add its directory to PATH and restart Actl. Checked: ${checked.join('; ') || '(no absolute search directories)'}`);
}
