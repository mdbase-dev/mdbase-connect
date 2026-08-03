import type { CollectionChange } from "@mdbase-dev/connect";

/**
 * Decide whether a batch of ordered structural events disagrees with the
 * editor's current index. Later events supersede earlier expectations for the
 * same path, so a rapid delete/restore or rename/rename-back is evaluated by
 * its final state rather than by an intermediate state that no longer exists.
 */
export function structuralChangesRequireRefresh(
  changes: readonly CollectionChange[],
  currentPaths: ReadonlySet<string>
): boolean {
  const expectedPresence = new Map<string, boolean>();

  for (const change of changes) {
    const path = typeof change.payload.path === "string" ? change.payload.path : undefined;
    const from = typeof change.payload.from === "string" ? change.payload.from : undefined;
    const to = typeof change.payload.to === "string" ? change.payload.to : undefined;

    if (change.type === "mdbase.record.created") {
      if (!path) return true;
      expectedPresence.set(path, true);
    } else if (change.type === "mdbase.record.deleted") {
      if (!path) return true;
      expectedPresence.set(path, false);
    } else if (change.type === "mdbase.record.renamed") {
      if (!from || !to) return true;
      expectedPresence.set(from, false);
      expectedPresence.set(to, true);
    }
  }

  return [...expectedPresence].some(([path, shouldExist]) => currentPaths.has(path) !== shouldExist);
}
