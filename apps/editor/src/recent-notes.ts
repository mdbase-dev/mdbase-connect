import { useCallback, useEffect, useState } from "react";

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

function saveRecentPaths(collectionId: string, paths: readonly string[]): void {
  try { localStorage.setItem(RECENT_NOTES_PREFIX + collectionId, JSON.stringify(paths)); }
  catch { /* Recents are a convenience; an unavailable store keeps them in memory. */ }
}

export function rememberRecentPath(current: readonly string[], path: string): string[] {
  return [path, ...current.filter((candidate) => candidate !== path)].slice(0, LIMIT);
}

export function forgetRecentPath(current: readonly string[], path: string): string[] {
  return current.filter((candidate) => candidate !== path);
}

/** Recently opened notes of one collection, saved with it as they change. */
export function useRecentPaths(collectionId: string | undefined) {
  const [recent, setRecent] = useState<{ collectionId?: string; paths: string[] }>({ paths: [] });
  useEffect(() => {
    setRecent(collectionId ? { collectionId, paths: loadRecentPaths(collectionId) } : { paths: [] });
  }, [collectionId]);
  const setPaths = useCallback((change: (current: string[]) => string[]) => setRecent((current) => {
    const paths = change(current.paths);
    if (current.collectionId) saveRecentPaths(current.collectionId, paths);
    return { ...current, paths };
  }), []);
  return [recent.paths, setPaths] as const;
}
