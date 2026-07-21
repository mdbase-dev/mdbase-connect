export interface EditorPreferences {
  vim: boolean;
  lineWrapping: boolean;
  fontSize: 16 | 17 | 19;
}

const storageKey = "mdbase-editor:preferences";

export const defaultPreferences: EditorPreferences = {
  vim: false,
  lineWrapping: true,
  fontSize: 17
};

export function loadPreferences(): EditorPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<EditorPreferences> | null;
    return {
      vim: typeof value?.vim === "boolean" ? value.vim : defaultPreferences.vim,
      lineWrapping: typeof value?.lineWrapping === "boolean" ? value.lineWrapping : defaultPreferences.lineWrapping,
      fontSize: value?.fontSize === 16 || value?.fontSize === 19 ? value.fontSize : defaultPreferences.fontSize
    };
  } catch {
    return defaultPreferences;
  }
}

export function savePreferences(value: EditorPreferences): void {
  localStorage.setItem(storageKey, JSON.stringify(value));
}
