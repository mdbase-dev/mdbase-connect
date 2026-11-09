const RECENT_NOTES_PREFIX = "mdbase-editor:recent-notes:";
/** Before recents were per collection, one list mixed every collection's paths. */
const SHARED_RECENT_NOTES_KEY = "mdbase-editor:recent-notes";
const LIMIT = 20;

export function loadRecentPaths(collectionId: string): string[] {
  try {
    localStorage.removeItem(SHARED_RECENT_NOTES_KEY);
    const value = JSON.parse(localStorage.getItem(RECENT_NOTES_PREFIX + collectionId) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveRecentPaths(collectionId: string, paths: readonly string[]): void {
  try { localStorage.setItem(RECENT_NOTES_PREFIX + collectionId, JSON.stringify(paths)); }
  catch { /* Recents are a convenience; an unavailable store keeps them in memory. */ }
}

export function rememberRecentPath(current: readonly string[], path: string): string[] {
  return [path, ...current.filter((candidate) => candidate !== path)].slice(0, LIMIT);
}

export function forgetRecentPath(current: readonly string[], path: string): string[] {
  return current.filter((candidate) => candidate !== path);
}
