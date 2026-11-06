import type { CompatibilityApi } from '../../shared/compatibility';

declare global {
  interface Window { actl: CompatibilityApi }
}
