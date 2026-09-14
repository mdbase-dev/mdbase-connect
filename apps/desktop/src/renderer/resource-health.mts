export async function refreshResources(
  resources: Record<string, () => Promise<unknown>>
): Promise<Record<string, string>> {
  const results = await Promise.all(Object.entries(resources).map(async ([name, request]) => {
    try { await request(); return undefined; }
    catch (error) { return [name, error instanceof Error ? error.message : String(error)] as const; }
  }));
  return Object.fromEntries(results.filter((result) => result !== undefined));
}

export function presentResourceFailures(failures: Record<string, string>): string | null {
  if (failures.connector) return `${failures.connector} Last-known information is shown; it may be out of date.`;
  const scopes = Object.keys(failures);
  return scopes.length === 0 ? null
    : `${scopes.join(", ")} could not refresh. Last-known information is shown; it may be out of date.`;
}

/** Offline is not an authoritative empty inventory. Explicit sign-out clears it. */
export function retainOfflineInventory<T extends { online: boolean }>(current: T, next: T): T {
  return next.online ? next : { ...current, online: false };
}
