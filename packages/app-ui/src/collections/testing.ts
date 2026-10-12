/**
 * `@mdbase-dev/ui/collections/testing`: for Node test runners that render the
 * collection components without a DOM environment per file.
 *
 * The components' focus and popover code reads the global `window` and
 * `document` (not the rendered element's `ownerDocument`), so the test's
 * window must also be the global one.
 */

const shared = [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement",
  "HTMLInputElement", "Event", "FocusEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "getComputedStyle",
  "matchMedia", "requestAnimationFrame", "cancelAnimationFrame",
] as const;

/**
 * Make `window` (a jsdom or happy-dom window) the global window and document
 * for the collection components. Returns a function that restores the
 * previous globals.
 *
 * ```ts
 * const restore = shareTestDocument(new JSDOM("<!doctype html><body></body>").window);
 * afterAll(restore);
 * ```
 */
export function shareTestDocument(window: object): () => void {
  const global = globalThis as Record<string, unknown>;
  const source = window as Record<string, unknown>;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of shared) {
    const value = name === "window" ? window : source[name];
    if (value === undefined) continue;
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: typeof value === "function" && /^[a-z]/.test(name) ? (value as (...args: unknown[]) => unknown).bind(window) : value,
    });
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete global[name];
    }
  };
}
