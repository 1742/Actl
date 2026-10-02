import { z } from "zod";
import type { WorkspaceStore } from "../../runtime/workspace-store.js";
import type { WebSearchService } from "../../web-search/search-service.js";
import type { WebSearchRequest } from "../../web-search/types.js";
import type { ToolCallContext, ToolDefinition, ToolPermissionRequirement, ToolProvider } from "../registry.js";

const domainSchema = z.string().trim().min(1).max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "Expected a hostname such as example.com.");

export const webSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe("Search query."),
  maxResults: z.number().int().min(1).max(10).optional().describe("Maximum number of results. Defaults to 8."),
  freshness: z.enum(["day", "week", "month", "year"]).optional().describe("Optional recency filter."),
  domains: z.array(domainSchema).max(5).optional().describe("Optional hostnames to restrict results to."),
}).strict();

export class WebSearchToolProvider implements ToolProvider {
  readonly name = "builtin-web-search";

  constructor(
    private readonly service: WebSearchService,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "web_search",
      description: "Search the public web for current information and return numbered sources with concise snippets. Use it for recent, changing, or externally verifiable facts. When using a result, cite it immediately after the supported claim as an inline Markdown link such as [1](https://example.com), using its citationId and exact url. If the tool reports that search is disabled or unconfigured, tell the user how to enable it in Settings > Web Search.",
      inputSchema: webSearchInputSchema,
      execution: { concurrency: "parallel" },
    }];
  }

  async getPermissionRequirement(_name: string, input: unknown): Promise<ToolPermissionRequirement> {
    const parsed = input as z.infer<typeof webSearchInputSchema>;
    return { capability: "network.search", resource: parsed.query, action: "read" };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name !== "web_search") throw new Error(`Unsupported builtin tool: ${name}`);
    const requirement = context.authorization?.requirement;
    if (!requirement || requirement.capability !== "network.search" || requirement.action !== "read") {
      throw new Error("Web search tool does not have authorization for this operation.");
    }
    if (!context.sessionId) throw new Error("Web search requires a session context.");
    const session = await this.workspaceStore.getSession(context.sessionId);
    if (!session) throw new Error("Session not found.");
    const parsed = input as z.infer<typeof webSearchInputSchema>;
    const request: WebSearchRequest = {
      query: parsed.query,
      ...(parsed.maxResults === undefined ? {} : { maxResults: parsed.maxResults }),
      ...(parsed.freshness === undefined ? {} : { freshness: parsed.freshness }),
      ...(parsed.domains === undefined ? {} : { domains: parsed.domains }),
    };
    return this.service.search(session.ownerId, request, context.signal);
  }
}
