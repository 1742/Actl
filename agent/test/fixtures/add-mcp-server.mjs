import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

void serveStdio(() => {
  const server = new McpServer({ name: "actl-test-add", version: "1.0.0" });
  server.registerTool("add", {
    description: "Add two numbers",
    inputSchema: z.object({ a: z.number(), b: z.number() }),
  }, ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  return server;
});
