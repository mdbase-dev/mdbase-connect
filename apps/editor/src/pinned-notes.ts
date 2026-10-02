export function loadPinnedNotes(collectionId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`mdbase-editor:pins:${collectionId}`) ?? "[]");
    return Array.isArray(value) ? value.filter((path): path is string => typeof path === "string") : [];
  } catch { return []; }
}
export function savePinnedNotes(collectionId: string, paths: string[]): void {
  localStorage.setItem(`mdbase-editor:pins:${collectionId}`, JSON.stringify(paths));
}
