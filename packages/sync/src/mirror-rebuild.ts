import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { MirrorInitializationConflictError } from "./mirror-errors.js";
import type { MirrorMaterializer } from "./mirror-materializer.js";
import { physicalMirrorPathKey } from "./mirror-physical-path.js";
import { validateSnapshotResources } from "./mirror-path-policy.js";
import {
  type MirrorEntry,
  type MirrorFileSystem,
  type MirrorProgress,
  type MirrorRuntime,
  type MirrorState
} from "./mirror-state.js";
import {
  MirrorSnapshotValidator,
  visitSnapshotPages,
  type ValidatedSnapshotRecord
} from "./mirror-snapshot-validator.js";
import type { SyncTransport } from "./sync-types.js";

interface RebuildOptions<Frontmatter extends JsonObject> {
  replicaId: string;
  transport: SyncTransport<Frontmatter>;
  mode: "read_only" | "read_write";
  fileSystem: MirrorFileSystem;
  runtime: MirrorRuntime;
  materializer: MirrorMaterializer;
  reportProgress: (progress: MirrorProgress) => void;
}

export async function openMirrorSnapshot<Frontmatter extends JsonObject>(
  replicaId: string,
  transport: SyncTransport<Frontmatter>,
  mode: "read_only" | "read_write"
): Promise<Awaited<ReturnType<SyncTransport<Frontmatter>["openSession"]>>> {
  const session = await transport.openSession();
  if (session.replica_id !== replicaId || session.mode !== mode) {
    throw new SyncError(
      "invalid_mirror_session",
      `Filesystem mirror requires its own ${mode.replace("_", "-")} replica.`
    );
  }
  return session;
}

export async function rebuildMirror<Frontmatter extends JsonObject>(
  options: RebuildOptions<Frontmatter>,
  prior?: MirrorState
): Promise<MirrorState> {
  const {
    replicaId,
    transport,
    mode,
    fileSystem,
    runtime,
    materializer,
    reportProgress
  } = options;
  const session = await openMirrorSnapshot(replicaId, transport, mode);
  const resources = session.resources.documents ?? [];
  const pathPolicy = validateSnapshotResources(resources);
  const snapshotValidator = new MirrorSnapshotValidator<Frontmatter>(
    pathPolicy,
    resources,
    runtime.digest
  );
  const state: MirrorState = {
    protocol_version: 1,
    replica_id: replicaId,
    scope_epoch: session.scope_epoch,
    cursor: session.head,
    records: {},
    resources: {},
    mode,
    pending: [],
    conflicts: {},
    local_issues: {}
  };
  const priorManagedByPhysicalPath = new Map<string, MirrorEntry>();
  if (prior) {
    for (const entry of Object.values(prior.resources ?? {})) {
      priorManagedByPhysicalPath.set(physicalMirrorPathKey(entry.path), entry);
    }
    for (const entry of Object.values(prior.records)) {
      priorManagedByPhysicalPath.set(physicalMirrorPathKey(entry.path), entry);
    }
  }
  const collisions: string[] = [];
  for (const resource of resources) {
    const local = await fileSystem.read(resource.path);
    const managed = prior
      ? priorManagedByPhysicalPath.get(physicalMirrorPathKey(resource.path))
      : undefined;
    if (managed && managed.path !== resource.path) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror paths ${managed.path} and ${resource.path} alias on a supported filesystem.`
      );
    }
    if (
      local !== null
      && local !== resource.document
      && (!managed || runtime.digest(local) !== managed.hash)
    ) {
      collisions.push(resource.path);
    }
  }
  const records: Array<ValidatedSnapshotRecord<Frontmatter>> = [];
  const remoteRecordIds = prior ? new Set<string>() : null;
  await visitSnapshotPages(transport, session, async (pageRecords) => {
    for (const snapshotRecord of pageRecords) {
      const prepared = snapshotValidator.validate(snapshotRecord);
      const { document, record } = prepared;
      const local = await fileSystem.read(record.path);
      const managed = prior
        ? priorManagedByPhysicalPath.get(physicalMirrorPathKey(record.path))
        : undefined;
      if (managed && managed.path !== record.path) {
        throw new SyncError(
          "invalid_record_path",
          `Mirror paths ${managed.path} and ${record.path} alias on a supported filesystem.`
        );
      }
      if (
        local !== null
        && local !== document
        && (!managed || runtime.digest(local) !== managed.hash)
      ) {
        collisions.push(record.path);
      }
      remoteRecordIds?.add(record.record_id);
      records.push(prepared);
    }
  });
  if (prior) {
    for (const [recordId, entry] of Object.entries(prior.records)) {
      if (remoteRecordIds!.has(recordId)) continue;
      const local = await fileSystem.read(entry.path);
      if (local !== null && runtime.digest(local) !== entry.hash) {
        collisions.push(entry.path);
      }
    }
    const remoteResources = new Set(resources.map((resource) => resource.path));
    for (const entry of Object.values(prior.resources ?? {})) {
      if (remoteResources.has(entry.path)) continue;
      const local = await fileSystem.read(entry.path);
      if (local !== null && runtime.digest(local) !== entry.hash) {
        collisions.push(entry.path);
      }
    }
  }
  if (collisions.length) {
    throw new MirrorInitializationConflictError(
      [...new Set(collisions)].sort()
    );
  }

  const documentCount = resources.length + records.length;
  let appliedDocuments = 0;
  const applied = (): void => {
    appliedDocuments += 1;
    reportProgress({
      phase: "applying",
      completed: appliedDocuments,
      total: documentCount,
      done: appliedDocuments === documentCount
    });
  };
  for (const resource of resources) {
    await materializer.putResource(state, resource, prior);
    applied();
  }
  for (const prepared of records) {
    await materializer.put(state, prepared.record, {
      managedState: prior,
      materialized: prepared
    });
    applied();
  }
  if (prior) {
    for (const [recordId, entry] of Object.entries(prior.records)) {
      if (!state.records[recordId]) {
        await materializer.remove(prior, recordId, entry.path);
      }
    }
    for (const [path, entry] of Object.entries(prior.resources ?? {})) {
      if (!state.resources?.[path]) {
        await materializer.removeResource(prior, path, entry);
      }
    }
  }
  state.last_synced_at = runtime.now();
  return state;
}
