// Standalone Electron reproducer: no Vue, preload, IPC, HTTP, or application data.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const profile = path.resolve(__dirname, '../artifacts/renderer-repro-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
let window;
const timer = setTimeout(() => app.exit(2), 10_000);
app.whenReady().then(async () => {
  console.log('Minimal sandboxed renderer:', JSON.stringify(process.versions));
  window = new BrowserWindow({ width: 500, height: 260, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer exited:', details);
    app.exit(1);
  });
  try {
    await window.loadURL('data:text/html,<title>Actl renderer probe</title><h1>Renderer started</h1>');
    console.log('PASS: minimal sandboxed renderer loaded.');
    clearTimeout(timer);
    setTimeout(() => app.quit(), 2_000);
  } catch (error) {
    console.error('FAIL:', error);
    app.exit(1);
  }
});
