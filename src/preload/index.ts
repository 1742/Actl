import { contextBridge, ipcRenderer } from 'electron';
import type { CompatibilityApi } from '../shared/compatibility';

const api: CompatibilityApi = {
  runChecks: () => ipcRenderer.invoke('compatibility:run'),
};
contextBridge.exposeInMainWorld('actl', Object.freeze(api));
