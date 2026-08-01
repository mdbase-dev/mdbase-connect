import type { JsonObject, SyncMutation } from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { MirrorDivergenceError } from "./mirror-errors.js";
import {
  frontmatterPatch,
  mirrorLocalIssue,
  parseMarkdown
} from "./mirror-format.js";
import {
  filterRecordPaths,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import { assertNoPhysicalPathAliases } from "./mirror-physical-path.js";
import type {
  MirrorFileSystem,
  MirrorRuntime,
  MirrorState,
  PendingMirrorMutation,
  StoredMirrorLocalIssue
} from "./mirror-state.js";

interface CaptureOptions {
  replicaId: string;
  state: MirrorState;
  pathPolicy: MirrorRecordPathPolicy;
  fileSystem: MirrorFileSystem;
  runtime: MirrorRuntime;
}

interface CapturedLocalChanges {
  pending: PendingMirrorMutation[];
  localIssues: Record<string, StoredMirrorLocalIssue>;
}

export async function captureMirrorLocalChanges({
  replicaId,
  state,
  pathPolicy,
  fileSystem,
  runtime
}: CaptureOptions): Promise<CapturedLocalChanges> {
  const resourcePaths = new Set(Object.keys(state.resources ?? {}));
  for (const [path, entry] of Object.entries(state.resources ?? {})) {
    const value = await fileSystem.read(path);
    if (value === null || runtime.digest(value) !== entry.hash) {
      throw new MirrorDivergenceError(`resource:${path}`, path);
    }
  }
  const files = filterRecordPaths(
    await fileSystem.listMarkdown(resourcePaths),
    pathPolicy
  );
  assertNoPhysicalPathAliases([...resourcePaths, ...files]);
  const managedPaths = new Map(
    Object.entries(state.records).map(([recordId, entry]) => [
      entry.path,
      recordId
    ])
  );
  const local = new Map<string, { document?: string; hash: string }>();
  for (const path of files) {
    const document = await fileSystem.read(path);
    if (document === null) continue;
    const hash = runtime.digest(document);
    const managed = managedPaths.get(path);
    const unchanged = managed !== undefined
      && state.records[managed]?.hash === hash;
    local.set(path, unchanged ? { hash } : { document, hash });
  }
  const untracked = new Set(
    [...local.keys()].filter((path) => !managedPaths.has(path))
  );
  const missing = new Set(
    Object.entries(state.records)
      .filter(([, entry]) => !local.has(entry.path))
      .map(([recordId]) => recordId)
  );
  const pending: PendingMirrorMutation[] = [];
  const localIssues: Record<string, StoredMirrorLocalIssue> = {};
  const parseLocal = (
    document: string,
    path: string,
    hash: string
  ): { frontmatter: JsonObject; body: string } | null => {
    try {
      return parseMarkdown(document, path);
    } catch (error) {
      const issue = mirrorLocalIssue(error, path);
      if (!issue) throw error;
      localIssues[path] = { ...issue, hash };
      return null;
    }
  };
  const predecessors = new Map<string, string>();
  const queue = (
    mutation: Omit<
      SyncMutation,
      "mutation_id" | "replica_id" | "scope_epoch" | "created_at"
    >,
    localPath: string,
    localHash: string | null
  ): void => {
    const mutationId = runtime.randomId();
    const predecessor = predecessors.get(mutation.record_id);
    pending.push({
      mutation: {
        ...mutation,
        mutation_id: mutationId,
        replica_id: replicaId,
        scope_epoch: state.scope_epoch,
        created_at: runtime.now(),
        ...(predecessor ? { causal_predecessor: predecessor } : {})
      },
      local_path: localPath,
      local_hash: localHash
    });
    predecessors.set(mutation.record_id, mutationId);
  };

  for (const recordId of [...missing]) {
    if (state.conflicts?.[recordId]) {
      missing.delete(recordId);
      continue;
    }
    const entry = state.records[recordId]!;
    const candidates = [...untracked].filter(
      (path) => local.get(path)?.hash === entry.hash
    );
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    queue({
      operation: "rename",
      record_id: recordId,
      base_revision: entry.revision,
      input: { path: target }
    }, target, local.get(target)!.hash);
    missing.delete(recordId);
    untracked.delete(target);
  }

  for (const [recordId, entry] of Object.entries(state.records)) {
    if (state.conflicts?.[recordId] || missing.has(recordId)) continue;
    const value = local.get(entry.path);
    if (!value || value.hash === entry.hash) continue;
    const record = entry.record;
    if (!record) {
      throw new SyncError(
        "mirror_state_upgrade_required",
        "Run a receive sync before editing this older writable mirror."
      );
    }
    const parsed = parseLocal(value.document!, entry.path, value.hash);
    if (!parsed) continue;
    queue({
      operation: "update",
      record_id: recordId,
      base_revision: entry.revision,
      input: {
        patch: frontmatterPatch(record.frontmatter, parsed.frontmatter),
        body: parsed.body
      }
    }, entry.path, value.hash);
  }

  for (const recordId of missing) {
    if (state.conflicts?.[recordId]) continue;
    const entry = state.records[recordId]!;
    queue({
      operation: "delete",
      record_id: recordId,
      base_revision: entry.revision,
      input: {}
    }, entry.path, null);
  }

  for (const path of untracked) {
    const value = local.get(path)!;
    const parsed = parseLocal(value.document!, path, value.hash);
    if (!parsed) continue;
    queue({
      operation: "create",
      record_id: runtime.randomId(),
      input: {
        path,
        frontmatter: parsed.frontmatter,
        body: parsed.body
      }
    }, path, value.hash);
  }
  return { pending, localIssues };
}
