import assert from "node:assert/strict";
import test from "node:test";
import { loadThemePreference, normalizeThemePreference, observeTheme, resolveDarkTheme, saveThemePreference } from "./theme.ts";

test("normalizes unsupported theme preferences to system", () => {
  assert.equal(normalizeThemePreference("sepia"), "system");
  assert.equal(normalizeThemePreference("dark"), "dark");
});

test("loads and saves a local theme preference", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); }
  };
  const attributes = new Map<string, string>();
  const root = {
    dataset: {} as DOMStringMap,
    removeAttribute(name: string) { attributes.delete(name); },
    setAttribute(name: string, value: string) { attributes.set(name, value); }
  } as unknown as HTMLElement;

  saveThemePreference("dark", storage, root);
  assert.equal(loadThemePreference(storage), "dark");
  assert.equal(root.dataset.theme, "dark");

  saveThemePreference("system", storage, root);
  assert.equal(loadThemePreference(storage), "system");
});

test("resolves the applied theme ahead of the system preference", () => {
  const root = (theme?: string) => ({ dataset: theme ? { theme } : {} }) as unknown as HTMLElement;

  assert.equal(resolveDarkTheme(root("dark")), true);
  assert.equal(resolveDarkTheme(root("light")), false);
  // No data-theme means "system", which is light here because Node has no matchMedia.
  assert.equal(resolveDarkTheme(root()), false);
});

test("stops observing the theme once released", () => {
  const observed: HTMLElement[] = [];
  let disconnected = 0;
  class MutationObserverStub {
    observe(target: HTMLElement) { observed.push(target); }
    disconnect() { disconnected += 1; }
  }
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = MutationObserverStub as unknown as typeof MutationObserver;

  try {
    const root = {} as HTMLElement;
    const release = observeTheme(() => {}, root);
    assert.deepEqual(observed, [root]);
    release();
    assert.equal(disconnected, 1);
  } finally {
    globalThis.MutationObserver = previous;
  }
});
