import type { SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import {
  pathFileSelected,
  sameBinaryInfo,
  validateVisibleCollectionPath,
  verifiedBinaryBytes,
  validateCollectionFileDescriptor
} from "./mirror-files.js";
import { assertNoPhysicalPathAliases } from "./mirror-physical-path.js";
import type {
  MirrorBlobStore,
  MirrorFileSystem,
  MirrorRuntime,
  MirrorState,
  PendingMirrorFileMutation
} from "./mirror-state.js";
import type { SyncTransport } from "./sync-types.js";

interface FileCaptureOptions {
  state: MirrorState;
  fileSystem: MirrorFileSystem;
  blobStore?: MirrorBlobStore;
  selectiveSync: SelectiveSyncPolicy;
  runtime: MirrorRuntime;
}

export async function captureMirrorLocalFiles(options: FileCaptureOptions): Promise<void> {
  const { state, fileSystem, blobStore, selectiveSync, runtime } = options;
  if (selectiveSync.file_classes.length === 0) return;
  if (!fileSystem.listBinary || !fileSystem.readBinary || !blobStore) {
    throw new SyncError(
      "writable_file_storage_unavailable",
      "Writable selected files require binary enumeration, streaming, and blob-store adapters."
    );
  }
  const excluded = new Set([
    ...Object.values(state.records).map((entry) => entry.path),
    ...Object.values(state.resources ?? {}).map((entry) => entry.path)
  ]);
  const paths = (await fileSystem.listBinary(excluded))
    .filter((path) => pathFileSelected(selectiveSync, path));
  for (const path of paths) validateVisibleCollectionPath(path, false);
  assertNoPhysicalPathAliases([
    ...excluded,
    ...paths,
    ...Object.values(state.files ?? {}).map((entry) => entry.file.path)
  ]);

  const local = new Map<string, NonNullable<Awaited<ReturnType<MirrorFileSystem["inspectBinary"]>>>>();
  for (const path of paths) {
    const info = await fileSystem.inspectBinary(path);
    if (info) local.set(path, info);
  }
  const untracked = new Set(paths);
  const missing = new Set<string>();
  for (const [fileId, entry] of Object.entries(state.files ?? {})) {
    if (local.has(entry.file.path)) untracked.delete(entry.file.path);
    else if (!state.file_conflicts?.[fileId]) missing.add(fileId);
  }
  const queued: PendingMirrorFileMutation[] = [];

  for (const fileId of [...missing]) {
    const prior = state.files![fileId]!.file;
    const candidates = [...untracked].filter((path) => {
      const info = local.get(path)!;
      return info.size === prior.size && info.content_digest === prior.content_digest;
    });
    if (candidates.length !== 1) continue;
    const path = candidates[0]!;
    const info = local.get(path)!;
    queued.push({
      operation: "move",
      mutation_id: runtime.randomId(),
      file_id: fileId,
      from_path: prior.path,
      path,
      base_revision: prior.revision,
      ...info
    });
    missing.delete(fileId);
    untracked.delete(path);
  }

  for (const [fileId, entry] of Object.entries(state.files ?? {})) {
    if (missing.has(fileId) || state.file_conflicts?.[fileId]) continue;
    const info = local.get(entry.file.path);
    if (!info || sameBinaryInfo(info, entry.file)) continue;
    await stageLocalFile(fileSystem, blobStore, entry.file.path, info);
    queued.push({
      operation: "upload",
      transfer_id: runtime.randomId(),
      file_id: fileId,
      path: entry.file.path,
      base_revision: entry.file.revision,
      ...info,
      ...(entry.file.media_type ? { media_type: entry.file.media_type } : {})
    });
  }
  for (const fileId of missing) {
    const file = state.files![fileId]!.file;
    queued.push({
      operation: "delete",
      mutation_id: runtime.randomId(),
      file_id: fileId,
      path: file.path,
      base_revision: file.revision
    });
  }
  for (const path of untracked) {
    const info = local.get(path)!;
    await stageLocalFile(fileSystem, blobStore, path, info);
    queued.push({
      operation: "upload",
      transfer_id: runtime.randomId(),
      path,
      ...info
    });
  }
  state.pending_files!.push(...queued);
}

export async function flushPendingMirrorFiles(
  state: MirrorState,
  transport: SyncTransport,
  blobStore: MirrorBlobStore | undefined,
  writeState: () => Promise<void>
): Promise<void> {
  if ((state.pending_files?.length ?? 0) === 0) return;
  if (!blobStore) {
    throw new SyncError(
      "writable_file_transport_unavailable",
      "Writable file mutations require a durable content-addressed blob store."
    );
  }
  while (state.pending_files!.length > 0) {
    const pending = state.pending_files![0]!;
    try {
      if (pending.operation === "upload") {
        if (pending.after_mutation_id) {
          throw new SyncError("invalid_mirror_state", "A file upload's prerequisite mutation is missing.");
        }
        if (!transport.uploadFile) throw writableFileTransportUnavailable("upload");
        const receipt = await transport.uploadFile({
          protocol_version: 1,
          type: "open_file_upload",
          transfer_id: pending.transfer_id,
          path: pending.path,
          size: pending.size,
          content_digest: pending.content_digest,
          ...(pending.media_type ? { media_type: pending.media_type } : {}),
          ...(pending.base_revision ? { if_revision: pending.base_revision } : {})
        }, blobStore.read(pending.content_digest));
        validateCollectionFileDescriptor(receipt.file);
        if (
          receipt.transfer_id !== pending.transfer_id
          || receipt.file.path !== pending.path
          || receipt.file.size !== pending.size
          || receipt.file.content_digest !== pending.content_digest
          || (pending.file_id !== undefined && receipt.file.file_id !== pending.file_id)
        ) throw new SyncError("invalid_sync_response", "Authority returned an invalid file upload receipt.");
        state.files![receipt.file.file_id] = { file: receipt.file };
      } else if (pending.operation === "move") {
        if (!transport.moveFile) throw writableFileTransportUnavailable("move");
        const receipt = await transport.moveFile({
          protocol_version: 1,
          type: "move_file",
          mutation_id: pending.mutation_id,
          file_id: pending.file_id,
          if_revision: pending.base_revision,
          from_path: pending.from_path,
          path: pending.path,
          update_references: false
        });
        validateCollectionFileDescriptor(receipt.file);
        if (receipt.mutation_id !== pending.mutation_id || receipt.file.file_id !== pending.file_id || receipt.file.path !== pending.path) {
          throw new SyncError("invalid_sync_response", "Authority returned an invalid file move receipt.");
        }
        state.files![pending.file_id] = { file: receipt.file };
        for (const later of state.pending_files!) {
          if (later.operation === "upload" && later.after_mutation_id === pending.mutation_id) {
            later.file_id = receipt.file.file_id;
            later.base_revision = receipt.file.revision;
            delete later.after_mutation_id;
          }
        }
      } else {
        if (!transport.deleteFile) throw writableFileTransportUnavailable("delete");
        const receipt = await transport.deleteFile({
          protocol_version: 1,
          type: "delete_file",
          mutation_id: pending.mutation_id,
          file_id: pending.file_id,
          if_revision: pending.base_revision,
          path: pending.path
        });
        if (receipt.mutation_id !== pending.mutation_id || receipt.file_id !== pending.file_id || receipt.previous_path !== pending.path) {
          throw new SyncError("invalid_sync_response", "Authority returned an invalid file delete receipt.");
        }
        delete state.files![pending.file_id];
      }
      delete state.file_conflicts![pendingFileKey(pending)];
      state.pending_files!.shift();
      await writeState();
    } catch (error) {
      const value = error instanceof Error ? error : new Error(String(error));
      const key = pendingFileKey(pending);
      state.file_conflicts![key] = {
        file_id: key,
        path: pending.path,
        code: errorCode(error),
        message: value.message
      };
      await writeState();
      throw error;
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof SyncError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "file_mutation_failed";
}

function pendingFileKey(pending: PendingMirrorFileMutation): string {
  return pending.operation === "upload" && !pending.file_id
    ? `new:${pending.path}`
    : pending.file_id!;
}

function writableFileTransportUnavailable(operation: string): SyncError {
  return new SyncError(
    "writable_file_transport_unavailable",
    `This authority transport cannot ${operation} collection files.`
  );
}

async function stageLocalFile(
  fileSystem: MirrorFileSystem,
  blobStore: MirrorBlobStore,
  path: string,
  info: NonNullable<Awaited<ReturnType<MirrorFileSystem["inspectBinary"]>>>
): Promise<void> {
  if (await blobStore.has(info.content_digest)) {
    try {
      for await (const _ of verifiedBinaryBytes(blobStore.read(info.content_digest), info, path)) {
        // Reuse only a complete, verified content-addressed snapshot.
      }
      return;
    } catch {
      await blobStore.remove(info.content_digest);
    }
  }
  const source = await fileSystem.readBinary!(path);
  if (!source) throw new SyncError("pending_local_changed", `Local file ${path} disappeared while being staged.`);
  try {
    await blobStore.write(info.content_digest, verifiedBinaryBytes(source, info, path));
    for await (const _ of verifiedBinaryBytes(blobStore.read(info.content_digest), info, path)) {
      // Verify that the durable pending snapshot is complete before journaling it.
    }
  } catch (error) {
    await blobStore.remove(info.content_digest).catch(() => undefined);
    throw error;
  }
}
