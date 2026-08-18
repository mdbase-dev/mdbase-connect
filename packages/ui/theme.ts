export const THEME_STORAGE_KEY = "mdbase:theme";

export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function normalizeThemePreference(value: unknown): ThemePreference {
  return themePreferences.includes(value as ThemePreference)
    ? value as ThemePreference
    : "system";
}

export function loadThemePreference(storage: ThemeStorage = localStorage): ThemePreference {
  try {
    return normalizeThemePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return typeof matchMedia === "function"
    && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDarkTheme(root: HTMLElement = document.documentElement): boolean {
  const applied = root.dataset.theme;
  return applied === "dark" || (applied !== "light" && prefersDark());
}

export function observeTheme(
  listener: () => void,
  root: HTMLElement = document.documentElement
): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(root, { attributeFilter: ["data-theme"] });
  const media = typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;
  media?.addEventListener("change", listener);
  return () => {
    observer.disconnect();
    media?.removeEventListener("change", listener);
  };
}

export function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement
): void {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = preference;
  const dark = preference === "dark" || (preference === "system" && prefersDark());
  if (typeof document !== "undefined") {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1c1e24" : "#fcfcfd");
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage: ThemeStorage = localStorage,
  root: HTMLElement = document.documentElement
): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme selection still applies for this session when storage is unavailable.
  }
  applyThemePreference(preference, root);
}
