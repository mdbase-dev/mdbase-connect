/** Every mdbase surface stores an explicit System, Light or Dark choice under this key. */
export const THEME_STORAGE_KEY = "mdbase:theme";

export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];

/** Browser chrome colours matching the light and dark canvas tokens. */
export const themeColors = { light: "#fcfcfd", dark: "#1b1d23" } as const;

export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
export type ThemeRoot = Pick<HTMLElement, "dataset" | "removeAttribute">;

export function normalizeThemePreference(value: unknown): ThemePreference {
  return themePreferences.includes(value as ThemePreference)
    ? value as ThemePreference
    : "system";
}

/** Storage may be absent (server rendering, extension pages) or blocked; both mean System. */
export function loadThemePreference(storage?: ThemeStorage): ThemePreference {
  try {
    return normalizeThemePreference((storage ?? localStorage).getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function prefersDark(): boolean {
  return typeof matchMedia === "function"
    && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDarkTheme(root: Pick<HTMLElement, "dataset"> = document.documentElement): boolean {
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
  root: ThemeRoot = document.documentElement
): void {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = preference;
  const dark = preference === "dark" || (preference === "system" && prefersDark());
  if (typeof document !== "undefined") {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? themeColors.dark : themeColors.light);
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage?: ThemeStorage,
  root: ThemeRoot = document.documentElement
): void {
  try {
    (storage ?? localStorage).setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme selection still applies for this session when storage is unavailable.
  }
  applyThemePreference(preference, root);
}
