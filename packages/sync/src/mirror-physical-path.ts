import type {
  JsonObject,
  SyncChange
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { assertRecordSyncChanges } from "./record-sync-change.js";
import type { MirrorState } from "./mirror-state.js";
import {
  portableMirrorPathKey,
  portableMirrorPathKeyForValidatedPath
} from "./portable-path.js";
import {
  validateRecordPath,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";

export function physicalMirrorPathKey(path: string): string {
  return portableMirrorPathKeyForValidatedPath(path);
}

export function assertRecordPhysicalPathAvailable(
  path: string,
  recordId: string,
  resourcePaths: Iterable<string>,
  records: Iterable<[string, { path: string }]>,
  files: Iterable<[string, { file: { path: string } }]> = []
): void {
  const physicalPath = physicalMirrorPathKey(path);
  for (const resourcePath of resourcePaths) {
    if (physicalMirrorPathKey(resourcePath) === physicalPath) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror record path ${path} aliases authority resource ${resourcePath} on a supported filesystem.`
      );
    }
  }
  for (const [existingId, entry] of records) {
    if (
      (existingId !== recordId || entry.path !== path)
      && physicalMirrorPathKey(entry.path) === physicalPath
    ) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror record paths ${entry.path} and ${path} alias on a supported filesystem.`
      );
    }
  }
  for (const [, entry] of files) {
    if (physicalMirrorPathKey(entry.file.path) === physicalPath) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror record path ${path} aliases collection file ${entry.file.path} on a supported filesystem.`
      );
    }
  }
}

export function assertFilePhysicalPathAvailable(
  path: string,
  fileId: string,
  state: MirrorState
): void {
  const physicalPath = physicalMirrorPathKey(path);
  for (const entry of Object.values(state.resources ?? {})) {
    if (physicalMirrorPathKey(entry.path) === physicalPath) {
      throw new SyncError("invalid_file_path", `Collection file ${path} aliases authority resource ${entry.path}.`);
    }
  }
  for (const entry of Object.values(state.records)) {
    if (physicalMirrorPathKey(entry.path) === physicalPath) {
      throw new SyncError("invalid_file_path", `Collection file ${path} aliases record ${entry.path}.`);
    }
  }
  for (const [existingId, entry] of Object.entries(state.files ?? {})) {
    if (
      (existingId !== fileId || entry.file.path !== path)
      && physicalMirrorPathKey(entry.file.path) === physicalPath
    ) {
      throw new SyncError(
        "invalid_file_path",
        `Collection files ${entry.file.path} and ${path} alias on a supported filesystem.`
      );
    }
  }
}

export function assertNoPhysicalPathAliases(paths: Iterable<string>): void {
  const physicalPaths = new Map<string, string>();
  for (const path of paths) {
    const physicalPath = physicalMirrorPathKey(path);
    const existing = physicalPaths.get(physicalPath);
    if (existing !== undefined && existing !== path) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror paths ${existing} and ${path} alias on a supported filesystem.`
      );
    }
    physicalPaths.set(physicalPath, path);
  }
}

export function* projectedPhysicalPaths(
  state: MirrorState,
  recordChanges: Map<string, string | null>,
  fileChanges: Map<string, string | null>
): Iterable<string> {
  const resources = state.resources ?? {};
  for (const path in resources) {
    if (Object.hasOwn(resources, path)) yield path;
  }
  for (const id in state.records) {
    if (!Object.hasOwn(state.records, id)) continue;
    const changed = recordChanges.get(id);
    if (changed !== null) yield changed ?? state.records[id]!.path;
    recordChanges.delete(id);
  }
  for (const path of recordChanges.values()) {
    if (path !== null) yield path;
  }
  const files = state.files ?? {};
  for (const id in files) {
    if (!Object.hasOwn(files, id)) continue;
    const changed = fileChanges.get(id);
    if (changed !== null) yield changed ?? files[id]!.file.path;
    fileChanges.delete(id);
  }
  for (const path of fileChanges.values()) {
    if (path !== null) yield path;
  }
}

/**
 * Proves that a complete change page is physically consistent with the
 * transitions this mirror can actually apply. Records deferred by a local
 * issue or conflict retain their current path for the whole page.
 */
export function preflightChangePhysicalPaths<
  Frontmatter extends JsonObject = JsonObject
>(
  events: Array<SyncChange<Frontmatter>>,
  policy: MirrorRecordPathPolicy,
  state: MirrorState
): void {
  assertRecordSyncChanges(events);
  const deferredRecordIds = new Set<string>();
  for (const [identity, conflict] of Object.entries(state.planned_conflicts ?? {})) {
    if (conflict.entity === "record") deferredRecordIds.add(identity);
  }

  const targetPhysicalPaths = new Set<string>();
  for (const event of events) {
    if (event.type !== "put") continue;
    validateRecordPath(event.record.path, policy);
    if (!deferredRecordIds.has(event.record.record_id)) {
      targetPhysicalPaths.add(portableMirrorPathKey(event.record.path));
    }
  }
  const occupiedTargets = new Map<
    string,
    { path: string; recordId: string | null }
  >();
  for (const path in state.resources ?? {}) {
    if (!Object.prototype.hasOwnProperty.call(state.resources, path)) continue;
    const physicalPath = portableMirrorPathKey(path);
    if (targetPhysicalPaths.has(physicalPath)) {
      occupiedTargets.set(physicalPath, { path, recordId: null });
    }
  }
  for (const recordId in state.records) {
    if (!Object.prototype.hasOwnProperty.call(state.records, recordId)) {
      continue;
    }
    const entry = state.records[recordId]!;
    const physicalPath = portableMirrorPathKey(entry.path);
    if (targetPhysicalPaths.has(physicalPath)) {
      occupiedTargets.set(physicalPath, { path: entry.path, recordId });
    }
  }

  const changedRecordPaths = new Map<string, string | null>();
  const currentRecordPath = (recordId: string): string | null =>
    changedRecordPaths.has(recordId)
      ? changedRecordPaths.get(recordId)!
      : state.records[recordId]?.path ?? null;
  for (const event of events) {
    const recordId = event.type === "put"
      ? event.record.record_id
      : event.record_id;
    if (deferredRecordIds.has(recordId)) continue;

    if (event.type === "remove") {
      const prior = currentRecordPath(recordId);
      if (prior !== null) {
        const priorPhysicalPath = portableMirrorPathKey(prior);
        if (occupiedTargets.get(priorPhysicalPath)?.recordId === recordId) {
          occupiedTargets.delete(priorPhysicalPath);
        }
      }
      changedRecordPaths.set(recordId, null);
      continue;
    }

    const physicalPath = portableMirrorPathKey(event.record.path);
    const occupied = occupiedTargets.get(physicalPath);
    if (
      occupied !== undefined
      && (occupied.recordId !== recordId || occupied.path !== event.record.path)
    ) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror paths ${occupied.path} and ${event.record.path} alias on a supported filesystem.`
      );
    }
    const prior = currentRecordPath(recordId);
    if (prior !== null) {
      const priorPhysicalPath = portableMirrorPathKey(prior);
      if (occupiedTargets.get(priorPhysicalPath)?.recordId === recordId) {
        occupiedTargets.delete(priorPhysicalPath);
      }
    }
    occupiedTargets.set(physicalPath, {
      path: event.record.path,
      recordId
    });
    changedRecordPaths.set(recordId, event.record.path);
  }
}
