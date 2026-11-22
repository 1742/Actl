import { realpathSync } from 'node:fs';
import path from 'node:path';
import koffi from 'koffi';
import { powerShellArgs } from '../agent-core/runtime/process/powershell.js';
import { AclSandbox, assertTempRootOutsideWorkspace, tempWriteSid, workspaceWriteSid, type AclSandboxOptions } from '../../vendor/windows-sandbox/acl/index.js';

function initializeUtf8Console(): void {
  const kernel = koffi.load('kernel32.dll');
  const getConsoleProcessList = kernel.func('__stdcall', 'GetConsoleProcessList', 'uint32', ['uint32 *', 'uint32']);
  const freeConsole = kernel.func('__stdcall', 'FreeConsole', 'int', []);
  const allocConsole = kernel.func('__stdcall', 'AllocConsole', 'int', []);
  const setConsoleOutputCP = kernel.func('__stdcall', 'SetConsoleOutputCP', 'int', ['uint32']);
  const getLastError = kernel.func('__stdcall', 'GetLastError', 'uint32', []);
  const fail = (operation: string): never => { throw new Error(`${operation} failed (Win32 ${getLastError()}).`); };

  // The runner has redirected stdio and starts hidden. PowerShell inherits its
  // console code page even when stdout and stderr use pipes.
  const attachedProcesses = getConsoleProcessList(new Uint32Array(1), 1);
  if (attachedProcesses > 1 && !freeConsole()) fail('FreeConsole');
  if (attachedProcesses !== 1 && !allocConsole()) fail('AllocConsole');
  if (!setConsoleOutputCP(65001)) fail('SetConsoleOutputCP');
}

function sandboxOptions(mode: string | undefined, args: string[]): AclSandboxOptions {
  if (mode === 'read-only' && args.length === 0) return { mode, writableDirs: [] };
  const [workspace, tempDir] = args;
  if (mode !== 'workspace-write' || args.length !== 2 || !workspace || !tempDir) throw new Error('Invalid sandbox invocation.');
  const root = realpathSync.native(workspace);
  if (root === path.parse(root).root || path.relative(workspace, root) !== '') {
    throw new Error('Workspace must be a canonical project directory.');
  }
  assertTempRootOutsideWorkspace(root, path.dirname(tempDir));
  return {
    mode, writableDirs: [root], writeSid: workspaceWriteSid(root),
    tempDir, tempWriteSid: tempWriteSid(tempDir),
  };
}

async function run(): Promise<number> {
  const [mode, cwd, shell, command, ...args] = process.argv.slice(2);
  if (!cwd || !shell || !command || !path.isAbsolute(shell)) throw new Error('Invalid sandbox invocation.');
  const options = sandboxOptions(mode, args);
  const sandbox = new AclSandbox(options);
  await sandbox.init();
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ACTL_SHELL_RUNNER;
    if (options.tempDir) process.env.TMP = process.env.TEMP = options.tempDir;
    initializeUtf8Console();
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
