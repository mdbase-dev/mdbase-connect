const RECENT_NOTES_KEY = "mdbase-editor:recent-notes";

export function loadRecentPaths(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_NOTES_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentPath(current: string[], path: string): string[] {
  const next = [path, ...current.filter((candidate) => candidate !== path)].slice(0, 20);
  localStorage.setItem(RECENT_NOTES_KEY, JSON.stringify(next));
  return next;
}

export function forgetRecentPath(current: string[], path: string): string[] {
  const next = current.filter((candidate) => candidate !== path);
  localStorage.setItem(RECENT_NOTES_KEY, JSON.stringify(next));
  return next;
}
