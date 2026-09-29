import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadThemePreference,
  normalizeThemePreference,
  observeTheme,
  resolveDarkTheme,
  saveThemePreference,
  type ThemeRoot
} from "./theme.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); }
  };
}

function memoryRoot(): ThemeRoot {
  const root = {
    dataset: {} as DOMStringMap,
    removeAttribute(name: string) {
      if (name === "data-theme") delete root.dataset.theme;
    }
  };
  return root;
}

describe("theme preference", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes unsupported preferences to system", () => {
    expect(normalizeThemePreference("sepia")).toBe("system");
    expect(normalizeThemePreference("dark")).toBe("dark");
  });

  it("loads and saves a local preference", () => {
    const storage = memoryStorage();
    const root = memoryRoot();

    saveThemePreference("dark", storage, root);
    expect(loadThemePreference(storage)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");

    saveThemePreference("system", storage, root);
    expect(loadThemePreference(storage)).toBe("system");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("falls back to system when storage is unavailable", () => {
    const storage = {
      getItem(): string | null { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); }
    };
    const root = memoryRoot();

    expect(loadThemePreference(storage)).toBe("system");
    saveThemePreference("light", storage, root);
    expect(root.dataset.theme).toBe("light");
  });

  it("treats missing storage as system", () => {
    // Node has no localStorage, as when a page renders outside the browser.
    expect(loadThemePreference(undefined)).toBe("system");
    const root = memoryRoot();
    saveThemePreference("dark", undefined, root);
    expect(root.dataset.theme).toBe("dark");
  });

  it("resolves the applied theme ahead of the system preference", () => {
    const root = (theme?: string) => ({ dataset: theme ? { theme } : {} }) as Pick<HTMLElement, "dataset">;

    expect(resolveDarkTheme(root("dark"))).toBe(true);
    expect(resolveDarkTheme(root("light"))).toBe(false);
    // No data-theme means "system", which is light here because Node has no matchMedia.
    expect(resolveDarkTheme(root())).toBe(false);
  });

  it("stops observing the theme once released", () => {
    const observed: unknown[] = [];
    let disconnected = 0;
    vi.stubGlobal("MutationObserver", class {
      observe(target: unknown) { observed.push(target); }
      disconnect() { disconnected += 1; }
    });

    const root = {} as HTMLElement;
    const release = observeTheme(() => {}, root);
    expect(observed).toEqual([root]);
    release();
    expect(disconnected).toBe(1);
  });
});
