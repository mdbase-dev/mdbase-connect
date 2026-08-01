export interface LayoutPreferences {
  collectionWidth: number;
  listWidth: number;
  inspectorWidth: number;
  collectionCollapsed: boolean;
  listCollapsed: boolean;
}

export const COLLECTION_WIDTH = { default: 176, min: 144, max: 280 } as const;
export const LIST_WIDTH = { default: 304, min: 240, max: 520 } as const;
export const INSPECTOR_WIDTH = { default: 340, min: 280, max: 560 } as const;

const storageKey = "mdbase-editor:layout";

export const defaultLayoutPreferences: LayoutPreferences = {
  collectionWidth: COLLECTION_WIDTH.default,
  listWidth: LIST_WIDTH.default,
  inspectorWidth: INSPECTOR_WIDTH.default,
  collectionCollapsed: false,
  listCollapsed: false
};

export function loadLayoutPreferences(): LayoutPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<LayoutPreferences> | null;
    return {
      collectionWidth: storedWidth(value?.collectionWidth, COLLECTION_WIDTH),
      listWidth: storedWidth(value?.listWidth, LIST_WIDTH),
      inspectorWidth: storedWidth(value?.inspectorWidth, INSPECTOR_WIDTH),
      collectionCollapsed: typeof value?.collectionCollapsed === "boolean" ? value.collectionCollapsed : false,
      listCollapsed: typeof value?.listCollapsed === "boolean" ? value.listCollapsed : false
    };
  } catch {
    return defaultLayoutPreferences;
  }
}

export function saveLayoutPreferences(value: LayoutPreferences): void {
  localStorage.setItem(storageKey, JSON.stringify(value));
}

function storedWidth(value: unknown, limits: { default: number; min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}
