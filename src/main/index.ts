import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { RuntimeHost } from './runtime-host';
import { registerRendererProtocol, rendererPageUrl } from './renderer-protocol';

const headless = process.argv.includes('--verify-runtime');
const argument = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const verificationRoot = argument('--verification-root');
if (headless && !verificationRoot) throw new Error('--verify-runtime requires --verification-root.');
app.setName('Actl');
if (verificationRoot) {
  if (!path.isAbsolute(verificationRoot)) throw new Error('Verification root must be absolute.');
  const profile = path.join(verificationRoot, 'profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'Actl-Electron'));
}

const runtime = new RuntimeHost();
let window: BrowserWindow | undefined;
let exiting = false;
const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

async function verify() {
  const root = verificationRoot ?? path.join(app.getPath('userData'), 'compatibility');
  const dataDirectory = path.join(root, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-中文 空格`);
  await mkdir(dataDirectory, { recursive: true });
  const report = await runtime.run({
    dataDirectory,
    fixturePath: app.isPackaged
      ? path.join(process.resourcesPath, 'compatibility-fixtures/mcp-server.cjs')
      : path.resolve(__dirname, '../fixtures/mcp-server.cjs'),
    packaged: app.isPackaged,
    mainPid: process.pid,
  });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function validateSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender.');
  }
  const expected = rendererUrl ?? rendererPageUrl;
  if (new URL(event.senderFrame.url).href !== new URL(expected).href) throw new Error('Untrusted renderer URL.');
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    title: 'Actl · Electron 兼容性验证',
    width: 1120, height: 820, minWidth: 860, minHeight: 650,
    show: false, backgroundColor: '#111316', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('Renderer load failed:', { code, description, url });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details);
  });
  window.webContents.on('will-navigate', (event, url) => {
    const expected = rendererUrl ?? rendererPageUrl;
    if (new URL(url).href !== new URL(expected).href) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = undefined; });
  if (rendererUrl) await window.loadURL(rendererUrl);
  else await window.loadURL(rendererPageUrl);
}

app.whenReady().then(async () => {
  app.setAppUserModelId('local.dev.actl.electron');
  if (headless) {
    try {
      const report = await verify();
      app.exit(report.passed ? 0 : 1);
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      await writeFile(path.join(verificationRoot!, 'error.txt'), message, 'utf8');
      app.exit(1);
    }
    return;
  }
  registerRendererProtocol(path.join(__dirname, '../renderer'));
  ipcMain.handle('compatibility:run', (event, ...args: unknown[]) => {
    validateSender(event);
    if (args.length > 0) throw new Error('This operation accepts no arguments.');
    return verify();
  });
  await createWindow();
}).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (exiting || !runtime.pending) return;
  event.preventDefault();
  exiting = true;
  void runtime.pending.finally(() => app.quit()).catch(() => undefined);
});
