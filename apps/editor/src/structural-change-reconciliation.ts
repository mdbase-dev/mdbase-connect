import type { CollectionChange } from "@mdbase-dev/connect";

export interface StructuralChangeReconciliation {
  requiresRefresh: boolean;
  /** Paths that may reflect a delayed delete and can be checked directly. */
  deletedPathsToConfirm: string[];
}

/**
 * Compare a batch of ordered structural events with the editor's current
 * index. Later events supersede earlier expectations for the same path, so a
 * rapid delete/restore or rename/rename-back is evaluated by its final state.
 * A lone delayed delete is returned separately because one authoritative read
 * can distinguish a restored record from a genuinely stale index.
 */
export function reconcileStructuralChanges(
  changes: readonly CollectionChange[],
  currentPaths: ReadonlySet<string>
): StructuralChangeReconciliation {
  const expectedPresence = new Map<string, { present: boolean; source: "create" | "delete" | "rename" }>();

  for (const change of changes) {
    if (change.kind === "record.created") {
      expectedPresence.set(change.path, { present: true, source: "create" });
    } else if (change.kind === "record.deleted") {
      expectedPresence.set(change.path, { present: false, source: "delete" });
    } else if (change.kind === "record.renamed") {
      expectedPresence.set(change.from, { present: false, source: "rename" });
      expectedPresence.set(change.to, { present: true, source: "rename" });
    } else return { requiresRefresh: true, deletedPathsToConfirm: [] };
  }

  const deletedPathsToConfirm: string[] = [];
  for (const [path, expected] of expectedPresence) {
    if (currentPaths.has(path) === expected.present) continue;
    if (!expected.present && expected.source === "delete") deletedPathsToConfirm.push(path);
    else return { requiresRefresh: true, deletedPathsToConfirm: [] };
  }
  return { requiresRefresh: false, deletedPathsToConfirm };
}
