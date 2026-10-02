import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteWorkspaceRepository } from "../src/repositories/sqlite-workspace-repository.js";
import { BASE_RUNTIME_INSTRUCTIONS, createDefaultPromptSettings, PromptCompiler } from "../src/runtime/prompt-compiler.js";
import type { Session } from "../src/runtime/workspace-store.js";

const session: Session = {
  id: "session", ownerId: "owner", projectId: null, cwd: null,
  created_at: "", updated_at: "", runs: [], fileChanges: [], compressionRecords: [],
  contextState: { sessionId: "session", summary: "Earlier decision", summarizedRunCount: 1, updatedAt: "" },
};

test("user blocks can be removed entirely and restored to the default text", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "actl-prompt-settings-"));
  const databasePath = path.join(directory, "workspace.db");
  const repository = new SqliteWorkspaceRepository(databasePath);
  try {
    await repository.initialize();
    const compiler = new PromptCompiler(repository);
    await writeFile(path.join(directory, "AGENTS.md"), "Project agents instructions");
    await writeFile(path.join(directory, "instructions.md"), "Project root instructions");
    const projectSession = { ...session, cwd: directory };
    const original = await compiler.compile(projectSession, []);
    assert.ok(original.instructions.indexOf("█ SESSION CONTEXT") < original.instructions.indexOf("Project agents instructions"));
    assert.ok(original.instructions.indexOf("Project agents instructions") < original.instructions.indexOf("Project root instructions"));
    assert.ok(original.instructions.indexOf("Project root instructions") < original.instructions.indexOf(BASE_RUNTIME_INSTRUCTIONS));
    assert.match(original.instructions, /<conversation_summary>\nEarlier decision\n<\/conversation_summary>/);

    const defaultBlock = createDefaultPromptSettings().blocks[0]!;
    const saved = repository.savePromptSettings("owner", 0, [
      { id: "custom:first", title: "First", text: "First custom instruction", enabled: true },
      defaultBlock,
      { id: "custom:off", title: "Off", text: "Should not appear", enabled: false },
    ]);
    assert.equal(saved?.revision, 1);
    assert.equal(repository.savePromptSettings("owner", 0, [defaultBlock]), null);

    const compiled = await compiler.compile(projectSession, []);
    assert.ok(compiled.instructions.indexOf("Project root instructions") < compiled.instructions.indexOf("First custom instruction"));
    assert.ok(compiled.instructions.indexOf("First custom instruction") < compiled.instructions.indexOf(BASE_RUNTIME_INSTRUCTIONS));
    assert.doesNotMatch(compiled.instructions, /Should not appear/);
    assert.match(compiled.instructions, /Earlier decision/);
    assert.deepEqual(compiled.sources.map((source) => source.kind), ["runtime", "project_instructions", "project_instructions", "user", "user", "user", "runtime"]);

    const empty = repository.savePromptSettings("owner", 1, []);
    assert.equal(empty?.revision, 2);
    const withoutUserBlocks = await compiler.compile(projectSession, []);
    assert.doesNotMatch(withoutUserBlocks.instructions, /First custom instruction|You are Actl Agent/);
    assert.match(withoutUserBlocks.instructions, /Project root instructions/);
    assert.match(withoutUserBlocks.instructions, /Earlier decision/);

    const restored = repository.savePromptSettings("owner", 2, createDefaultPromptSettings().blocks);
    assert.equal(restored?.revision, 3);
    assert.match((await compiler.compile(projectSession, [])).instructions, /You are Actl Agent/);
    repository.close();

    await repository.initialize();
    assert.deepEqual(repository.getPromptSettings("owner"), restored);
    assert.equal(repository.getPromptSettings("another"), undefined);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
