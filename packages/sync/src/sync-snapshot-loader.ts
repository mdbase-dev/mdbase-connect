import type {
  CollectionFileDescriptor,
  JsonObject,
  SelectiveSyncPolicy,
  SyncSession
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { assertNoPhysicalPathAliases } from "./mirror-physical-path.js";
import {
  fileSelected,
  pathSelected,
  visitFileSnapshotPages
} from "./mirror-files.js";
import { validateSnapshotResources } from "./mirror-path-policy.js";
import type { MirrorRuntime } from "./mirror-state.js";
import {
  MirrorSnapshotValidator,
  visitSnapshotPages,
  type ValidatedSnapshotRecord
} from "./mirror-snapshot-validator.js";
import type { SyncTransport } from "./sync-types.js";

export interface LoadedMirrorSnapshot<Frontmatter extends JsonObject> {
  session: SyncSession;
  resources: NonNullable<SyncSession["resources"]["documents"]>;
  records: Array<ValidatedSnapshotRecord<Frontmatter>>;
  files: CollectionFileDescriptor[];
}

export async function openMirrorSnapshot<Frontmatter extends JsonObject>(
  replicaId: string,
  transport: SyncTransport<Frontmatter>,
  mode: "read_only" | "read_write"
): Promise<Awaited<ReturnType<SyncTransport<Frontmatter>["openSession"]>>> {
  const session = await transport.openSession();
  if (
    session.protocol_version !== 1
    || session.protocol_profile !== "exact_document_v1"
    || session.replica_id !== replicaId
    || session.mode !== mode
  ) {
    throw new SyncError(
      "sync_protocol_incompatible",
      `Filesystem mirror requires exact-document v1 and its own ${mode.replace("_", "-")} replica.`
    );
  }
  return session;
}

export async function loadMirrorSnapshot<Frontmatter extends JsonObject>(
  replicaId: string,
  transport: SyncTransport<Frontmatter>,
  mode: "read_only" | "read_write",
  selectiveSync: SelectiveSyncPolicy,
  runtime: MirrorRuntime
): Promise<LoadedMirrorSnapshot<Frontmatter>> {
  const session = await openMirrorSnapshot(replicaId, transport, mode);
  const resources = session.resources.documents ?? [];
  const pathPolicy = validateSnapshotResources(resources);
  const validator = new MirrorSnapshotValidator<Frontmatter>(
    pathPolicy,
    resources,
    runtime.digest
  );
  const records: Array<ValidatedSnapshotRecord<Frontmatter>> = [];
  await visitSnapshotPages(transport, session, async (pageRecords) => {
    for (const snapshotRecord of pageRecords) {
      const prepared = validator.validate(snapshotRecord);
      if (pathSelected(selectiveSync, prepared.record.path)) records.push(prepared);
    }
  });
  const files: CollectionFileDescriptor[] = [];
  const remoteFileIds = new Set<string>();
  await visitFileSnapshotPages(transport, session, async (pageFiles) => {
    for (const file of pageFiles) {
      if (!fileSelected(selectiveSync, file)) continue;
      if (remoteFileIds.has(file.file_id)) {
        throw new SyncError("invalid_snapshot", `Hosted snapshot repeats file identity ${file.file_id}.`);
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
  return { session, resources, records, files };
}
