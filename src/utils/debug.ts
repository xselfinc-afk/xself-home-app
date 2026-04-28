/**
 * Lightweight debug helpers.
 * All functions are no-ops in production — __DEV__ is stripped by Metro.
 */

/** Returns true only in development builds when the flag is explicitly true. */
export function debugEnabled(flag: boolean): boolean {
  return __DEV__ && flag === true;
}

/** Scoped console.log — only emits in development builds. */
export function debugLog(scope: string, message: string, data?: unknown): void {
  if (__DEV__) {
    console.log(`[DEBUG:${scope}] ${message}`, data ?? '');
  }
}
