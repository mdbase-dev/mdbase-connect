export interface EditorPreferences {
  vim: boolean;
  lineWrapping: boolean;
  quietMarkdown: boolean;
  fontSize: 16 | 17 | 19;
}

const storageKey = "mdbase-editor:preferences";

export const defaultPreferences: EditorPreferences = {
  vim: false,
  lineWrapping: true,
  quietMarkdown: true,
  fontSize: 17
};

export function loadPreferences(): EditorPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<EditorPreferences> | null;
    return {
      vim: typeof value?.vim === "boolean" ? value.vim : defaultPreferences.vim,
      lineWrapping: typeof value?.lineWrapping === "boolean" ? value.lineWrapping : defaultPreferences.lineWrapping,
      quietMarkdown: typeof value?.quietMarkdown === "boolean" ? value.quietMarkdown : defaultPreferences.quietMarkdown,
      fontSize: value?.fontSize === 16 || value?.fontSize === 19 ? value.fontSize : defaultPreferences.fontSize
    };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(value: EditorPreferences): void {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

export function initialEditorSurface(): "notes" | "types" | "settings" {
  const requested = new URLSearchParams(location.search).get("surface");
  return requested === "types" || requested === "settings" ? requested : "notes";
}
