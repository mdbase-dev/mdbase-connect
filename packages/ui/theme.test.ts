import assert from "node:assert/strict";
import test from "node:test";
import { loadThemePreference, normalizeThemePreference, saveThemePreference } from "./theme.ts";

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
