import { app, BrowserWindow, Menu, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { registerRendererProtocol, rendererPageUrl } from './renderer-protocol';
import { DesktopAgent } from './desktop-agent';

const forcedExitProbe = process.argv.includes('--verify-agent-exit-probe');
const verifyAgentMode = process.argv.includes('--verify-agent') || forcedExitProbe;
const argument = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const verificationRoot = argument('--verification-root');
if (verifyAgentMode && !verificationRoot) throw new Error('Verification requires --verification-root.');
app.setName('Actl');
if (verificationRoot) {
  if (!path.isAbsolute(verificationRoot)) throw new Error('Verification root must be absolute.');
  const profile = path.join(verificationRoot, 'profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'Actl-Electron'));
}
const ownsInstance = verifyAgentMode || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

const desktop = new DesktopAgent(() => window, validateSender);
let window: BrowserWindow | undefined;
let exiting = false;
const rendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

function validateSender(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender.');
  }
  const expected = rendererUrl ?? rendererPageUrl;
  const actualUrl = new URL(event.senderFrame.url); actualUrl.hash = '';
  if (actualUrl.href !== new URL(expected).href) throw new Error('Untrusted renderer URL.');
}

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    title: 'Actl',
    width: 1280, height: 800, minWidth: 860, minHeight: 650,
    show: false, backgroundColor: '#111316', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
    ...(!app.isPackaged && { icon: path.join(app.getAppPath(), 'build', 'icon.ico') }),
  });
  window = mainWindow;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('context-menu', (_event, params) => {
    const { editFlags, isEditable, selectionText } = params;
    const items: MenuItemConstructorOptions[] = [];

    if (isEditable) {
      items.push(
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      );
    } else if (selectionText && editFlags.canCopy) {
      items.push({ role: 'copy' });
    }

    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({
      window: mainWindow,
      ...(params.frame && { frame: params.frame }),
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    });
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('Renderer load failed:', { code, description, url });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details);
  });
  window.webContents.on('will-navigate', (event, url) => {
    const expected = rendererUrl ?? rendererPageUrl;
    const target = new URL(url); target.hash = '';
    if (target.href !== new URL(expected).href) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) desktop.detachAll(); });
  window.on('closed', () => { desktop.detachAll(); window = undefined; });
  if (rendererUrl) await window.loadURL(rendererUrl);
  else await window.loadURL(rendererPageUrl);
}

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  app.setAppUserModelId('local.dev.actl.electron');
  if (verifyAgentMode) {
    try {
      const { verifyAgent } = await import('../../tests/electron/agent-checks');
      const report = await verifyAgent(verificationRoot!, app.isPackaged, forcedExitProbe);
      app.exit(report.passed ? 0 : 1);
    } catch (error) {
      await writeFile(path.join(verificationRoot!, 'error.txt'), error instanceof Error ? error.stack ?? error.message : String(error), 'utf8');
      app.exit(1);
    }
    return;
  }
  registerRendererProtocol(path.join(__dirname, '../renderer'));
  desktop.register();
  await createWindow();
}).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
app.on('before-quit', (event) => {
  if (exiting || verifyAgentMode) return;
  event.preventDefault();
  exiting = true;
  void desktop.close().catch((error) => console.error('Agent shutdown failed:', error)).finally(() => app.quit());
});
