import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

if (process.argv.includes('--orphan-child')) {
  const marker = process.argv.at(-1)!;
  writeFileSync(marker, JSON.stringify({ pid: process.pid, parentPid: process.ppid }));
  // Bound the lifetime even if an intentionally failing regression is interrupted.
  const heartbeat = setInterval(() => {}, 250);
  setTimeout(() => { clearInterval(heartbeat); process.exit(0); }, 60_000);
} else if (process.argv.includes('--orphan-probe')) {
  const child = spawn(process.execPath, [__filename, '--orphan-child', process.argv.at(-1)!], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('error', () => process.exit(1));
  child.unref();
} else if (process.argv.includes('--process-probe')) {
  process.stdout.write(`ACTL_PROCESS_PID=${process.pid}\n`);
  setInterval(() => process.stdout.write('probe-alive\n'), 250);
} else {
  void serveStdio(() => {
    const server = new McpServer({ name: 'actl-verification-math', version: '0.1.0' });
    server.registerTool('add', {
      description: 'Add two numbers for the local verification check.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
    }, ({ a, b }) => ({
      content: [{ type: 'text', text: JSON.stringify({ sum: a + b, pid: process.pid, node: process.versions.node }) }],
    }));
    return server;
  });
}
