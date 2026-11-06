import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { WorkspaceFileService } from "../../../runtime/workspace-files.js";
import { pathsEqual, resolveToolPath } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";

interface ContentMatch {
  file: string;
  line: number;
  column: number;
  endColumn: number;
  content: string;
  contextBefore: string[];
  contextAfter: string[];
}

const nonEmptyStringSchema = z.string().trim().min(1);

export const searchFilesInputSchema = z.object({
  pattern: nonEmptyStringSchema.describe("Glob pattern (e.g., '**/*.ts', 'src/**/user*')."),
  path: nonEmptyStringSchema.optional().describe("Optional absolute path or path relative to the Session cwd."),
  maxResults: z.number().int().min(1).max(2_000).default(200),
  includeHidden: z.boolean().default(false),
}).strict();

export const searchContentInputSchema = z.object({
  pattern: nonEmptyStringSchema.describe("Regular expression pattern."),
  path: nonEmptyStringSchema.optional().describe("Optional absolute path or path relative to the Session cwd."),
  fileTypes: z.string().trim().optional()
    .describe("Optional comma-separated file extensions (e.g., '.ts,.js')."),
  contextLines: z.number().int().nonnegative().max(20).default(2),
  caseSensitive: z.boolean().default(true),
  maxResults: z.number().int().min(1).max(2_000).default(500),
  includeHidden: z.boolean().default(false),
}).strict();

type SearchFilesInput = z.infer<typeof searchFilesInputSchema>;
type SearchContentInput = z.infer<typeof searchContentInputSchema>;

export class SearchToolHandler implements FilesystemToolHandler {
  constructor(private readonly workspaceFiles = new WorkspaceFileService()) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "search_files",
        description: "Find accessible files matching a glob pattern. Honors the selected root's .gitignore and returns truncation metadata.",
        inputSchema: searchFilesInputSchema,
        execution: { concurrency: "parallel" },
      },
      {
        name: "search_content",
        description: "Search accessible UTF-8 file contents with a regex, returning matching lines, context, and truncation metadata.",
        inputSchema: searchContentInputSchema,
        execution: { concurrency: "parallel" },
      },
    ];
  }

  async getPermissionRequirement(name: string, input: unknown, context: ToolCallContext): Promise<ToolPermissionRequirement> {
    if (name === "search_files" || name === "search_content") {
      const resource = await resolveToolPath(context.cwd, (input as SearchFilesInput | SearchContentInput).path ?? ".");
      return { capability: "filesystem.search", resource, action: "read" };
    }
    throw new Error(`Unsupported search tool: ${name}`);
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    const searchRoot = await resolveToolPath(context.cwd, (input as SearchFilesInput | SearchContentInput).path ?? ".");
    const requirement = context.authorization?.requirement;
    if (!requirement || requirement.capability !== "filesystem.search" ||
      !requirement.resource || !pathsEqual(requirement.resource, searchRoot)) {
      throw new Error("Search tool does not have authorization for the resolved path.");
    }
    if (name === "search_files") return this.searchFiles(input as SearchFilesInput, searchRoot, context.signal);
    if (name === "search_content") return this.searchContent(input as SearchContentInput, searchRoot, context.signal);
    throw new Error(`Unsupported search tool: ${name}`);
  }

  private async searchFiles(input: SearchFilesInput, searchRoot: string, signal?: AbortSignal): Promise<unknown> {
    return this.workspaceFiles.searchGlob(searchRoot, {
      pattern: input.pattern,
      path: ".",
      includeHidden: input.includeHidden,
      maxResults: input.maxResults,
      ...(signal ? { signal } : {}),
    });
  }

  private async searchContent(input: SearchContentInput, searchRoot: string, signal?: AbortSignal): Promise<unknown> {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const extensions = parseExtensions(input.fileTypes);
    const matches: ContentMatch[] = [];
    const state = await this.workspaceFiles.walkFiles(searchRoot, {
      path: ".",
      includeHidden: input.includeHidden,
      extensions,
      ...(signal ? { signal } : {}),
    }, async (filePath, relativePath) => {
      signal?.throwIfAborted();
      const buffer = await readFile(filePath, { signal });
      if (buffer.byteLength > 5 * 1024 * 1024 || buffer.subarray(0, 8_192).includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        signal?.throwIfAborted();
        const line = lines[index] ?? "";
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          const start = Math.max(0, index - input.contextLines);
          const end = Math.min(lines.length, index + input.contextLines + 1);
          matches.push({
            file: relativePath,
            line: index + 1,
            column: match.index + 1,
            endColumn: match.index + Math.max(match[0].length, 1),
            content: line,
            contextBefore: lines.slice(start, index),
            contextAfter: lines.slice(index + 1, end),
          });
          if (matches.length >= input.maxResults) {
            return true;
          }
          if (match[0].length === 0) regex.lastIndex += 1;
        }
      }
    });
    return { matches, scannedFiles: state.scannedFiles, truncated: matches.length >= input.maxResults };
  }
}

function parseExtensions(value: string | undefined): Set<string> | null {
  if (!value) return null;
  const extensions = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
    .map((item) => item.startsWith(".") ? item : `.${item}`);
  return extensions.length > 0 ? new Set(extensions) : null;
}
