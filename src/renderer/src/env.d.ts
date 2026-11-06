import type { DesktopApi } from '../../shared/agent-ipc';
import type { CompatibilityApi } from '../../shared/compatibility';
declare global {
  interface Window { actlAgent: DesktopApi; actl: CompatibilityApi }
}
