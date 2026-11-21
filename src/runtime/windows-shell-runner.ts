import { realpathSync } from 'node:fs';
import path from 'node:path';
import { powerShellArgs } from '../agent-core/runtime/process/powershell.js';
import { AclSandbox, assertTempRootOutsideWorkspace, tempWriteSid, workspaceWriteSid } from '../../vendor/windows-sandbox/acl/index.js';

async function run(): Promise<number> {
  const [workspace, tempDir, cwd, shell, command] = process.argv.slice(2);
  if (!workspace || !tempDir || !cwd || !shell || !command || !path.isAbsolute(shell)) throw new Error('Invalid sandbox invocation.');
  const root = realpathSync.native(workspace);
  if (root === path.parse(root).root || path.relative(workspace, root) !== '') {
    throw new Error('Workspace must be a canonical project directory.');
  }
  assertTempRootOutsideWorkspace(root, path.dirname(tempDir));
  const sandbox = new AclSandbox({
    mode: 'workspace-write', writableDirs: [root], writeSid: workspaceWriteSid(root),
    tempDir, tempWriteSid: tempWriteSid(tempDir),
  });
  await sandbox.init();
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ACTL_SHELL_RUNNER;
    process.env.TMP = process.env.TEMP = tempDir;
    const child = sandbox.spawn({ command: shell, args: powerShellArgs(command), cwd, stdio: 'inherit' });
    return (await child.wait()).exitCode;
  } finally {
    sandbox.dispose();
  }
}

run().then(code => { process.exitCode = code; }, error => {
  const detail = error instanceof AggregateError ? [error, ...error.errors].map(String).join('\n') : String(error);
  process.stderr.write(`Actl Windows sandbox failed: ${detail}\n`);
  process.exitCode = 127;
});
