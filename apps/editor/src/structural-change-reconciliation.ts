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
    const path = typeof change.payload.path === "string" ? change.payload.path : undefined;
    const from = typeof change.payload.from === "string" ? change.payload.from : undefined;
    const to = typeof change.payload.to === "string" ? change.payload.to : undefined;

    if (change.type === "mdbase.record.created") {
      if (!path) return { requiresRefresh: true, deletedPathsToConfirm: [] };
      expectedPresence.set(path, { present: true, source: "create" });
    } else if (change.type === "mdbase.record.deleted") {
      if (!path) return { requiresRefresh: true, deletedPathsToConfirm: [] };
      expectedPresence.set(path, { present: false, source: "delete" });
    } else if (change.type === "mdbase.record.renamed") {
      if (!from || !to) return { requiresRefresh: true, deletedPathsToConfirm: [] };
      expectedPresence.set(from, { present: false, source: "rename" });
      expectedPresence.set(to, { present: true, source: "rename" });
    }
  }

  const deletedPathsToConfirm: string[] = [];
  for (const [path, expected] of expectedPresence) {
    if (currentPaths.has(path) === expected.present) continue;
    if (!expected.present && expected.source === "delete") deletedPathsToConfirm.push(path);
    else return { requiresRefresh: true, deletedPathsToConfirm: [] };
  }
  return { requiresRefresh: false, deletedPathsToConfirm };
}
