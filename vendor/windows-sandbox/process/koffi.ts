/** Process-realm lazy access to Koffi's CommonJS entry. */

import type koffi from 'koffi'
import koffiRuntime from 'koffi'

/** Koffi runtime export type. */
export type Koffi = typeof koffi

/** Load Koffi on the first Win32 native operation. */
export const requireKoffi = (): Koffi => koffiRuntime
