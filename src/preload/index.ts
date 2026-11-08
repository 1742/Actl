import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/agent-ipc';

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
  writeClipboardText: (text) => ipcRenderer.invoke('desktop:clipboard:write-text', text),
  getSettings: () => ipcRenderer.invoke('desktop:settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('desktop:settings:save', settings),
  pickDirectory: () => ipcRenderer.invoke('desktop:pick-directory'),
  openDirectory: (kind) => ipcRenderer.invoke('desktop:open-directory', kind),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  revealWorkspaceFile: (projectId, path) => ipcRenderer.invoke('desktop:reveal-workspace-file', projectId, path),
  openProjectDirectory: (projectId) => ipcRenderer.invoke('desktop:open-project-directory', projectId),
  notify: (kind, title, detail) => ipcRenderer.invoke('desktop:notify', kind, title, detail),
};
contextBridge.exposeInMainWorld('actlAgent', Object.freeze(desktop));
