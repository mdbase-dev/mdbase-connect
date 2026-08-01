import type {
  CollectionFileDescriptor,
  JsonObject,
  SelectiveSyncPolicy
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { MirrorInitializationConflictError } from "./mirror-errors.js";
import type { MirrorMaterializer } from "./mirror-materializer.js";
import {
  assertNoPhysicalPathAliases,
  physicalMirrorPathKey
} from "./mirror-physical-path.js";
import {
  ensureFileBlob,
  fileSelected,
  pathSelected,
  sameBinaryInfo,
  visitFileSnapshotPages
} from "./mirror-files.js";
import { validateSnapshotResources } from "./mirror-path-policy.js";
import {
  type MirrorEntry,
  type MirrorBlobStore,
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
  blobStore?: MirrorBlobStore;
  selectiveSync: SelectiveSyncPolicy;
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
    blobStore,
    selectiveSync,
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
    files: {},
    selective_sync: selectiveSync,
    mode,
    pending: [],
    pending_files: [],
    conflicts: {},
    file_conflicts: {},
    local_issues: {}
  };
  const priorManagedByPhysicalPath = new Map<string, MirrorEntry>();
  const priorFilesByPhysicalPath = new Map<string, CollectionFileDescriptor>();
  if (prior) {
    for (const entry of Object.values(prior.resources ?? {})) {
      priorManagedByPhysicalPath.set(physicalMirrorPathKey(entry.path), entry);
    }
    for (const entry of Object.values(prior.records)) {
      priorManagedByPhysicalPath.set(physicalMirrorPathKey(entry.path), entry);
    }
    for (const entry of Object.values(prior.files ?? {})) {
      priorFilesByPhysicalPath.set(physicalMirrorPathKey(entry.file.path), entry.file);
    }
  }
  const collisions: string[] = [];
  for (const resource of resources) {
    const local = await fileSystem.read(resource.path);
    const managed = prior
      ? priorManagedByPhysicalPath.get(physicalMirrorPathKey(resource.path))
      : undefined;
    const managedFile = prior
      ? priorFilesByPhysicalPath.get(physicalMirrorPathKey(resource.path))
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
      && (!managedFile || !sameBinaryInfo(await fileSystem.inspectBinary(resource.path), managedFile))
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
      if (!pathSelected(selectiveSync, record.path)) continue;
      const local = await fileSystem.read(record.path);
      const managed = prior
        ? priorManagedByPhysicalPath.get(physicalMirrorPathKey(record.path))
        : undefined;
      const managedFile = prior
        ? priorFilesByPhysicalPath.get(physicalMirrorPathKey(record.path))
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
        && (!managedFile || !sameBinaryInfo(await fileSystem.inspectBinary(record.path), managedFile))
      ) {
        collisions.push(record.path);
      }
      remoteRecordIds?.add(record.record_id);
      records.push(prepared);
    }
  });
  const files: CollectionFileDescriptor[] = [];
  const remoteFileIds = new Set<string>();
  await visitFileSnapshotPages(transport, session, async (pageFiles) => {
    for (const file of pageFiles) {
      if (!fileSelected(selectiveSync, file)) continue;
      if (remoteFileIds.has(file.file_id)) {
        throw new SyncError(
          "invalid_snapshot",
          `Hosted snapshot repeats file identity ${file.file_id}.`
        );
      }
      remoteFileIds.add(file.file_id);
      files.push(file);
    }
  });
  assertNoPhysicalPathAliases([
    ...resources.map((resource) => resource.path),
    ...records.map(({ record }) => record.path),
    ...files.map((file) => file.path)
  ]);
  for (const file of files) {
    const local = await fileSystem.inspectBinary(file.path);
    const priorFile = prior?.files?.[file.file_id];
    const priorFileAtPath = priorFilesByPhysicalPath.get(physicalMirrorPathKey(file.path));
    const priorDocument = priorManagedByPhysicalPath.get(physicalMirrorPathKey(file.path));
    const localDocument = priorDocument ? await fileSystem.read(file.path) : null;
    if (
      local !== null
      && !sameBinaryInfo(local, file)
      && (!priorFile || priorFile.file.path !== file.path || !sameBinaryInfo(local, priorFile.file))
      && (!priorFileAtPath || !sameBinaryInfo(local, priorFileAtPath))
      && (!priorDocument || localDocument === null || runtime.digest(localDocument) !== priorDocument.hash)
    ) {
      collisions.push(file.path);
    }
  }
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
    for (const [fileId, entry] of Object.entries(prior.files ?? {})) {
      if (remoteFileIds.has(fileId)) continue;
      const local = await fileSystem.inspectBinary(entry.file.path);
      if (local !== null && !sameBinaryInfo(local, entry.file)) {
        collisions.push(entry.file.path);
      }
    }
  }
  if (collisions.length) {
    throw new MirrorInitializationConflictError(
      [...new Set(collisions)].sort()
    );
  }

  if (files.length > 0 && !blobStore) {
    throw new SyncError(
      "file_storage_unavailable",
      "Selected collection files require a content-addressed blob store adapter."
    );
  }
  let downloadedFiles = 0;
  for (const file of files) {
    await ensureFileBlob(transport, blobStore!, file);
    downloadedFiles += 1;
    reportProgress({
      phase: "downloading",
      completed: downloadedFiles,
      total: files.length,
      done: downloadedFiles === files.length
    });
  }

  const documentCount = resources.length + records.length + files.length;
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
  for (const file of files) {
    await materializer.putFile(state, file, prior);
    applied();
  }
  if (prior) {
    const targetPhysicalPaths = new Set([
      ...Object.values(state.resources ?? {}).map((entry) => physicalMirrorPathKey(entry.path)),
      ...Object.values(state.records).map((entry) => physicalMirrorPathKey(entry.path)),
      ...Object.values(state.files ?? {}).map((entry) => physicalMirrorPathKey(entry.file.path))
    ]);
    for (const [recordId, entry] of Object.entries(prior.records)) {
      if (!state.records[recordId] && !targetPhysicalPaths.has(physicalMirrorPathKey(entry.path))) {
        await materializer.remove(prior, recordId, entry.path);
      }
    }
    for (const [path, entry] of Object.entries(prior.resources ?? {})) {
      if (!state.resources?.[path] && !targetPhysicalPaths.has(physicalMirrorPathKey(entry.path))) {
        await materializer.removeResource(prior, path, entry);
      }
    }
    for (const fileId of Object.keys(prior.files ?? {})) {
      const entry = prior.files?.[fileId];
      if (
        entry
        && !state.files?.[fileId]
        && !targetPhysicalPaths.has(physicalMirrorPathKey(entry.file.path))
      ) await materializer.removeFile(prior, fileId);
    }
  }
  state.last_synced_at = runtime.now();
  return state;
}
