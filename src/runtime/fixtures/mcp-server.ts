import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

if (process.argv.includes('--process-probe')) {
  process.stdout.write(`ACTL_PROCESS_PID=${process.pid}\n`);
  setInterval(() => process.stdout.write('probe-alive\n'), 250);
} else {
  void serveStdio(() => {
    const server = new McpServer({ name: 'actl-compatibility-math', version: '0.1.0' });
    server.registerTool('add', {
      description: 'Add two numbers for the local compatibility check.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
    }, ({ a, b }) => ({
      content: [{ type: 'text', text: JSON.stringify({ sum: a + b, pid: process.pid, node: process.versions.node }) }],
    }));
    return server;
  });
}
