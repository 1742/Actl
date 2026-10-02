import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import iconv from "iconv-lite";
import { z } from "zod";
import type { ProcessOwner } from "../../runtime/process/process-types.js";
import { ProcessSupervisor } from "../../runtime/process/process-supervisor.js";
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
}

const nonEmptyStringSchema = z.string().trim().min(1);
export const shellInputSchema = z.object({
  command: nonEmptyStringSchema.describe("Shell command to execute."),
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

  constructor(private readonly processSupervisor: ProcessSupervisor) {}

  async listTools(): Promise<ToolDefinition[]> {
    const runtime = getShellRuntime();
    return [
      {
        name: "shell",
        description: `Run a shell command with the host process permissions. Return immediately when it exits, or after yieldTimeMs with a processId while it keeps running. Use shell_poll to wait for completion or read later output, and shell_stop to terminate it. Current shell: ${runtime.description}`,
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
        capability: "process.spawn",
        resource: resolved.resource,
        action: "execute",
      };
    }
    if (name === "shell_poll" || name === "shell_stop") {
      const owner = this.requireOwner(context);
      const processId = name === "shell_poll"
        ? (input as ShellPollInput).processId
        : (input as ShellStopInput).processId;
      if (!this.processSupervisor.owns(owner, processId)) throw new Error("process_not_found");
      return {
        capability: name === "shell_poll" ? "process.read" : "process.terminate",
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
      this.assertAuthorization(context, "process.spawn", "execute", resolved.resource);
      const outputEncoding = await detectShellOutputEncoding(runtime);
      const owner = this.requireOwner(context);
      const started = await this.processSupervisor.start({
        owner,
        command: resolved.command,
        cwd: resolved.cwd,
        shell: runtime.executable,
        outputEncoding,
        env: resolved.env,
        startupWaitMs: resolved.yieldTimeMs ?? DEFAULT_YIELD_TIME_MS,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (context.signal?.aborted) {
        await this.processSupervisor.stop({ owner, processId: started.processId });
        context.signal.throwIfAborted();
      }
      return started;
    }
    if (name === "shell_poll") {
      const parsed = input as ShellPollInput;
      this.assertAuthorization(context, "process.read", "read", parsed.processId);
      return this.processSupervisor.poll({
        owner: this.requireOwner(context),
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
      this.assertAuthorization(context, "process.terminate", "terminate", parsed.processId);
      return this.processSupervisor.stop({
        owner: this.requireOwner(context),
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
    this.requireOwner(context);

    const baseDirectory = toolBaseDirectory(context.cwd);
    const candidateCwd = parsed.cwd
      ? path.isAbsolute(parsed.cwd) ? parsed.cwd : path.resolve(baseDirectory, parsed.cwd)
      : baseDirectory;
    const resolvedCwd = await canonicalizePotentialPath(candidateCwd);

    const resolved: ResolvedShellCommand = {
      command: parsed.command,
      cwd: resolvedCwd,
      env: { ...process.env },
      resource: "",
    };
    resolved.resource = createShellResource(parsed.command, resolvedCwd);
    if (parsed.yieldTimeMs !== undefined) resolved.yieldTimeMs = parsed.yieldTimeMs;
    return resolved;
  }

  private requireOwner(context: ToolCallContext): ProcessOwner {
    if (!context.sessionId) throw new Error("Shell tools require a session context.");
    return { type: "session", id: context.sessionId };
  }

  private assertAuthorization(context: ToolCallContext, capability: string, action: string, resource: string): void {
    const requirement = context.authorization?.requirement;
    if (!requirement || requirement.capability !== capability || requirement.action !== action || requirement.resource !== resource) {
      throw new Error("Shell tool does not have authorization for this operation.");
    }
  }
}

function createShellResource(command: string, cwd: string): string {
  return JSON.stringify({ cwd: path.normalize(cwd), command });
}

export function getShellRuntime(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellRuntime {
  if (platform === "win32") {
    return {
      platform,
      executable: environment.ComSpec?.trim() || "cmd.exe",
      description: "Windows cmd.exe. Use cmd syntax and commands (for example dir), not Unix-only commands such as ls.",
    };
  }
  return { platform, executable: "/bin/sh", description: "POSIX /bin/sh. Use POSIX shell syntax and commands (for example ls)." };
}

export async function detectShellOutputEncoding(runtime: ShellRuntime): Promise<string> {
  if (runtime.platform !== "win32") return "utf8";
  try {
    const output = await runCodePageProbe(runtime.executable);
    return encodingForWindowsCodePage(parseWindowsCodePage(output));
  } catch {
    return "utf8";
  }
}

export function parseWindowsCodePage(output: Buffer): number | null {
  const match = output.toString("ascii").match(/(?:^|\D)(\d{3,5})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

export function encodingForWindowsCodePage(codePage: number | null): string {
  if (codePage === null || codePage === 65001) return "utf8";
  const aliases: Record<number, string> = { 932: "shift_jis", 936: "gbk", 949: "cp949", 950: "big5" };
  const encoding = aliases[codePage] ?? `cp${codePage}`;
  return iconv.encodingExists(encoding) ? encoding : "utf8";
}

export function decodeShellOutput(output: Buffer, fallbackEncoding: string): string {
  return isUtf8(output) ? output.toString("utf8") : iconv.decode(output, fallbackEncoding);
}

function runCodePageProbe(shell: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("chcp", { shell, windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => exitCode === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(`chcp exited with code ${exitCode ?? "unknown"}.`)));
  });
}
