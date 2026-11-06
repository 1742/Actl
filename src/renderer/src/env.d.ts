import type { DesktopApi } from '../../shared/agent-ipc';
declare global {
  interface Window { actlAgent: DesktopApi }
}
