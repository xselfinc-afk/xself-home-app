/**
 * Cross-component "is the app ready to show" signal.
 *
 * HomeScreen calls markHomeReady() as soon as it has *something* to render
 * (either a hydrated cache or a fresh Supabase payload, success OR final
 * error). App.tsx's splash-hide effect subscribes to this signal so the
 * native splash stays up until Home is paintable — eliminating the empty-
 * layout / "No products available yet" flash during cold start.
 */

let _ready = false;
let _listeners: Array<() => void> = [];

export function isHomeReady(): boolean {
  return _ready;
}

export function markHomeReady(): void {
  if (_ready) return;
  _ready = true;
  const snapshot = _listeners.slice();
  _listeners = [];
  for (const fn of snapshot) {
    try { fn(); } catch (err) {
      if (__DEV__) console.warn('[bootGate] listener threw:', err instanceof Error ? err.message : err);
    }
  }
}

export function onHomeReady(fn: () => void): () => void {
  if (_ready) {
    // Defer so callers can always assume async ordering.
    Promise.resolve().then(fn);
    return () => {};
  }
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(l => l !== fn); };
}

/** Test/debug only. */
export function _resetBootGate(): void {
  _ready = false;
  _listeners = [];
}
