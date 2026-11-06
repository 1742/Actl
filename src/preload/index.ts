import { contextBridge, ipcRenderer } from 'electron';
import type { CompatibilityApi } from '../shared/compatibility';
import type { DesktopApi } from '../shared/agent-ipc';

const api: CompatibilityApi = {
  runChecks: () => ipcRenderer.invoke('compatibility:run'),
};
contextBridge.exposeInMainWorld('actl', Object.freeze(api));
const desktop: DesktopApi = {
  ready: () => ipcRenderer.invoke('agent:ready'),
  request: (command) => ipcRenderer.invoke('agent:request', command),
  stream: (id, command) => ipcRenderer.invoke('agent:stream', id, command),
  onEvents: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, batch: Parameters<typeof listener>[0]) => listener(batch);
    ipcRenderer.on('agent:events', handler);
    return () => ipcRenderer.removeListener('agent:events', handler);
  },
  detach: (id) => ipcRenderer.send('agent:detach', id),
  restart: () => ipcRenderer.invoke('desktop:restart'),
  getSettings: () => ipcRenderer.invoke('desktop:settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop:settings:save', settings),
  pickDirectory: () => ipcRenderer.invoke('desktop:pick-directory'),
  openDirectory: (kind) => ipcRenderer.invoke('desktop:open-directory', kind),
  notify: (kind, title, detail) => ipcRenderer.invoke('desktop:notify', kind, title, detail),
};
contextBridge.exposeInMainWorld('actlAgent', Object.freeze(desktop));
