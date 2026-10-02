import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryHookEventBus } from "../src/hooks/event-bus.js";
import { createSilentLogger } from "../src/observability/logger.js";
import { RunPermissionEngine, type PermissionMode } from "../src/permissions/engine.js";
import type { AgentRunRecord } from "../src/runtime/agent-domain.js";
import { ToolBatchExecutor } from "../src/runtime/agent-loop/tool-batch-executor.js";
import { ProcessSupervisor } from "../src/runtime/process/process-supervisor.js";
import type { ManagedProcessPoll } from "../src/runtime/process/process-types.js";
import type { Session, WorkspaceStore } from "../src/runtime/workspace-store.js";
import { ShellToolProvider, shellInputSchema, shellPollInputSchema, shellStopInputSchema } from "../src/tools/builtin/shell.js";
import { ToolRegistry, type ToolCallContext } from "../src/tools/registry.js";

async function runShell(provider: ShellToolProvider, input: unknown): Promise<ManagedProcessPoll> {
  const context: ToolCallContext = { cwd: process.cwd(), sessionId: "shell-test" };
  const requirement = await provider.getPermissionRequirement("shell", input, context);
  return provider.callTool("shell", input, {
    ...context,
    authorization: { requirement, approvedByUser: true },
  }) as Promise<ManagedProcessPoll>;
}

test("shell returns completed commands and keeps longer commands available for polling", async () => {
  const supervisor = new ProcessSupervisor();
  const provider = new ShellToolProvider(supervisor);
  try {
    assert.deepEqual((await provider.listTools()).map((tool) => tool.name), ["shell", "shell_poll", "shell_stop"]);

    const quick = await runShell(provider, {
      command: `"${process.execPath}" -e "console.log('quick')"`,
      yieldTimeMs: 5_000,
    });
    assert.equal(quick.status, "exited");
    assert.equal(quick.exitCode, 0);
    assert.match(quick.output.map((chunk) => chunk.text).join(""), /quick/);

    const slow = await runShell(provider, {
      command: `"${process.execPath}" -e "console.log('started'); setTimeout(() => process.exit(7), 350)"`,
      yieldTimeMs: 0,
    });
    assert.equal(slow.status, "running");
    assert.ok(slow.processId);

    const owner = { type: "session" as const, id: "shell-test" };
    const completed = await supervisor.poll({
      owner,
      processId: slow.processId,
      cursor: slow.nextCursor,
      waitMs: 5_000,
      waitForExit: true,
    });
    assert.equal(completed.status, "exited");
    assert.equal(completed.exitCode, 7);
    assert.match(completed.output.map((chunk) => chunk.text).join(""), /started/);
  } finally {
    await supervisor.dispose();
  }
});

test("shell wait time is not a process termination timeout", () => {
  assert.equal(shellInputSchema.safeParse({ command: "echo hi", yieldTimeMs: 120_000 }).success, true);
  assert.equal(shellInputSchema.safeParse({ command: "echo hi", timeoutMs: 1 }).success, false);
});

test("shell_poll reads from a line number and rejects mixed read positions", async () => {
  const supervisor = new ProcessSupervisor();
  const provider = new ShellToolProvider(supervisor);
  const context: ToolCallContext = { cwd: process.cwd(), sessionId: "shell-test" };
  try {
    const started = await runShell(provider, {
      command: `"${process.execPath}" -e "console.log('first'); console.log('second'); console.log('third')"`,
      yieldTimeMs: 5_000,
    });
    const input = shellPollInputSchema.parse({ processId: started.processId, line: 2 });
    const requirement = await provider.getPermissionRequirement("shell_poll", input, context);
    const result = await provider.callTool("shell_poll", input, {
      ...context,
      authorization: { requirement, approvedByUser: true },
    }) as ManagedProcessPoll;
    assert.equal(result.output.map((chunk) => chunk.text).join("").replaceAll("\r\n", "\n"), "second\nthird\n");
    assert.equal(result.nextLine, 4);
    assert.equal(shellPollInputSchema.safeParse({ processId: started.processId, cursor: 1, line: 2 }).success, false);
    assert.equal(shellStopInputSchema.safeParse({ processId: started.processId, cursor: 1, line: 2 }).success, false);
  } finally {
    await supervisor.dispose();
  }
});

test("shell_stop returns output after the supplied cursor and reports stopped status", async () => {
  const supervisor = new ProcessSupervisor();
  const provider = new ShellToolProvider(supervisor);
  const context: ToolCallContext = { cwd: process.cwd(), sessionId: "shell-test" };
  try {
    const started = await runShell(provider, {
      command: `"${process.execPath}" -e "console.log('already-read'); setInterval(() => {}, 1000)"`,
      yieldTimeMs: 500,
    });
    assert.equal(started.status, "running");
    assert.match(started.output.map((chunk) => chunk.text).join(""), /already-read/);

    const input = shellStopInputSchema.parse({ processId: started.processId, cursor: started.nextCursor });
    const requirement = await provider.getPermissionRequirement("shell_stop", input, context);
    const stopped = await provider.callTool("shell_stop", input, {
      ...context,
      authorization: { requirement, approvedByUser: true },
    }) as ManagedProcessPoll;
    assert.equal(stopped.status, "stopped");
    assert.doesNotMatch(stopped.output.map((chunk) => chunk.text).join(""), /already-read/);
    assert.equal(stopped.nextCursor, started.nextCursor);

    const full = await supervisor.stop({ owner: { type: "session", id: "shell-test" }, processId: started.processId });
    assert.match(full.output.map((chunk) => chunk.text).join(""), /already-read/);
    const lineInput = shellStopInputSchema.parse({ processId: started.processId, line: 1 });
    const lineRequirement = await provider.getPermissionRequirement("shell_stop", lineInput, context);
    const byLine = await provider.callTool("shell_stop", lineInput, {
      ...context,
      authorization: { requirement: lineRequirement, approvedByUser: true },
    }) as ManagedProcessPoll;
    assert.match(byLine.output.map((chunk) => chunk.text).join(""), /already-read/);
  } finally {
    await supervisor.dispose();
  }
});

test("tool batch passes the session to shell and reports the run permission mode", async () => {
  const supervisor = new ProcessSupervisor();
  const registry = new ToolRegistry();
  registry.registerProvider(new ShellToolProvider(supervisor));
  const workspaceStore = { touch: async () => {} } as unknown as WorkspaceStore;
  const executor = new ToolBatchExecutor(
    registry, new RunPermissionEngine(), new InMemoryHookEventBus(), workspaceStore, createSilentLogger(),
  );
  const session = { id: "conversation-session", cwd: process.cwd() } as Session;
  try {
    for (const permissionMode of ["accept_edits", "full_access"] satisfies PermissionMode[]) {
      const run = {
        id: `run-${permissionMode}`, timeline: [], permissionSnapshot: { permissionMode },
        modelSnapshot: { targetId: "test" },
      } as unknown as AgentRunRecord;
      const paused = await executor.process(session, run, [{
        type: "tool_call", id: "item", callId: "call", name: "shell",
        argumentsJson: JSON.stringify({ command: "echo from-batch", yieldTimeMs: 5_000 }),
      }], new AbortController().signal);
      assert.equal(paused, false);
      const result = run.timeline.find((item) => item.type === "tool_result");
      assert.ok(result);
      const envelope = result.content[0];
      assert.equal(envelope?.type, "json");
      if (envelope?.type !== "json") throw new Error("Expected JSON tool result.");
      const value = envelope.value as {
        ok: boolean;
        execution: { permissionMode: PermissionMode; permission: string };
        output?: ManagedProcessPoll;
        error?: string;
      };
      assert.equal(value.ok, true, value.error);
      assert.deepEqual(value.execution, { permissionMode, permission: "automatic" });
      assert.equal(value.output?.status, "exited");
      assert.match(value.output.output.map((chunk) => chunk.text).join(""), /from-batch/);
    }
  } finally {
    await supervisor.dispose();
  }
});
