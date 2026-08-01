import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  CollectionFileDescriptor,
  FileMediaClass,
  SelectiveSyncPolicy,
  SyncFileSnapshotPage,
  SyncSession
} from "@mdbase-dev/connect-protocol";
import { portableMirrorPathKey, validatePortableMirrorPath } from "./portable-path.js";
import { SyncError } from "./sync-error.js";
import type { MirrorBlobStore, MirrorBinaryInfo } from "./mirror-file-types.js";
import type { SyncTransport } from "./sync-types.js";

const FILE_CLASSES = new Set<FileMediaClass>(["image", "audio", "video", "pdf", "other"]);
const FILE_CLASS_ORDER: FileMediaClass[] = ["image", "audio", "video", "pdf", "other"];
const RESERVED_DIRECTORIES = new Set([
  ".mdbase",
  ".git",
  "node_modules",
  "_contracts",
  "_schemas",
  "_types",
  "_views"
]);
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function normalizeSelectiveSyncPolicy(
  policy: SelectiveSyncPolicy | undefined
): SelectiveSyncPolicy {
  const normalized: SelectiveSyncPolicy = {
    file_classes: [...(policy?.file_classes ?? [])],
    excluded_folders: [...(policy?.excluded_folders ?? [])]
  };
  if (normalized.excluded_folders.length > 100) {
    throw new SyncError(
      "invalid_file_materialization",
      "Selective sync supports at most 100 excluded folders."
    );
  }
  const classes = new Set<FileMediaClass>();
  for (const mediaClass of normalized.file_classes) {
    if (!FILE_CLASSES.has(mediaClass) || classes.has(mediaClass)) {
      throw new SyncError(
        "invalid_file_materialization",
        "Selected file media classes must be valid and unique."
      );
    }
    classes.add(mediaClass);
  }
  const folders = new Set<string>();
  const physicalFolders = new Set<string>();
  for (const folder of normalized.excluded_folders) {
    validateVisibleCollectionPath(folder, true);
    const physical = portableMirrorPathKey(folder);
    if (folders.has(folder) || physicalFolders.has(physical)) {
      throw new SyncError(
        "invalid_file_materialization",
        "Excluded folders must be unique on portable filesystems."
      );
    }
    folders.add(folder);
    physicalFolders.add(physical);
  }
  normalized.file_classes.sort(
    (left, right) => FILE_CLASS_ORDER.indexOf(left) - FILE_CLASS_ORDER.indexOf(right)
  );
  normalized.excluded_folders.sort((left, right) =>
    portableMirrorPathKey(left).localeCompare(portableMirrorPathKey(right))
  );
  return normalized;
}

export function pathSelected(policy: SelectiveSyncPolicy, path: string): boolean {
  const pathKey = portableMirrorPathKey(path);
  return !policy.excluded_folders.some((folder) => {
    const folderKey = portableMirrorPathKey(folder);
    return pathKey === folderKey || pathKey.startsWith(`${folderKey}/`);
  });
}

export function fileSelected(
  policy: SelectiveSyncPolicy,
  file: CollectionFileDescriptor
): boolean {
  return policy.file_classes.includes(file.media_class) && pathSelected(policy, file.path);
}

export function classifyFileMediaClass(path: string): FileMediaClass {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (["flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"].includes(extension)) return "audio";
  if (["3gp", "mkv", "mov", "mp4", "webm"].includes(extension)) return "video";
  if (extension === "pdf") return "pdf";
  return "other";
}

export function pathFileSelected(policy: SelectiveSyncPolicy, path: string): boolean {
  return policy.file_classes.includes(classifyFileMediaClass(path)) && pathSelected(policy, path);
}

export function validateCollectionFileDescriptor(file: CollectionFileDescriptor): void {
  validateVisibleCollectionPath(file.path, false);
  if (
    typeof file.file_id !== "string"
    || !UUID.test(file.file_id)
    || typeof file.revision !== "string"
    || !file.revision
    || file.revision.length > 255
    || !SHA256_DIGEST.test(file.content_digest)
    || !Number.isSafeInteger(file.size)
    || file.size < 0
    || !FILE_CLASSES.has(file.media_class)
    || typeof file.modified_at !== "string"
    || !RFC3339.test(file.modified_at)
    || !Number.isFinite(Date.parse(file.modified_at))
    || (file.media_type !== undefined && (
      typeof file.media_type !== "string"
      || !file.media_type
      || file.media_type.length > 255
    ))
  ) {
    throw new SyncError(
      "invalid_snapshot",
      `Collection file ${file.path} has invalid metadata.`
    );
  }
}

export function validateVisibleCollectionPath(path: string, folder: boolean): void {
  validatePortableMirrorPath(path);
  if (path.length > 1024) {
    throw new SyncError("invalid_file_path", "Collection file paths cannot exceed 1024 characters.");
  }
  const components = path.split("/");
  const unsafe = components.some((component) =>
    component.startsWith(".")
    || /[<>"|?*]/u.test(component)
    || WINDOWS_RESERVED.test(component)
    || RESERVED_DIRECTORIES.has(component.toLowerCase())
  );
  if (unsafe || (!folder && /\.md$/iu.test(path))) {
    throw new SyncError(
      "invalid_file_path",
      `Collection file path ${path} is hidden, reserved, or non-portable.`
    );
  }
}

export async function visitFileSnapshotPages(
  transport: SyncTransport,
  session: SyncSession,
  visitor: (files: CollectionFileDescriptor[]) => Promise<void>
): Promise<void> {
  let page: string | undefined;
  const seenPages = new Set<string>();
  do {
    const snapshot: SyncFileSnapshotPage = await transport.fileSnapshot(session.snapshot_id, page);
    if (
      snapshot.protocol_version !== 1
      || snapshot.type !== "file_snapshot_page"
      || snapshot.snapshot_id !== session.snapshot_id
      || snapshot.scope_epoch !== session.scope_epoch
      || snapshot.cursor !== session.head
    ) {
      throw new SyncError(
        "invalid_snapshot",
        "Authority file snapshot boundary changed during download."
      );
    }
    for (const file of snapshot.files) validateCollectionFileDescriptor(file);
    await visitor(snapshot.files);
    page = snapshot.next_page;
    if (page !== undefined && seenPages.has(page)) {
      throw new SyncError("invalid_snapshot", "Authority file snapshot repeated a page cursor.");
    }
    if (page !== undefined) seenPages.add(page);
  } while (page);
}

export function sameBinaryInfo(
  info: MirrorBinaryInfo | null,
  file: CollectionFileDescriptor
): boolean {
  return info?.size === file.size && info.content_digest === file.content_digest;
}

/** Verify a byte stream without buffering it. Consumers must drain it fully. */
export async function* verifiedFileBytes(
  source: AsyncIterable<Uint8Array>,
  file: CollectionFileDescriptor
): AsyncGenerator<Uint8Array> {
  const hash = sha256.create();
  let size = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      if (chunk instanceof Uint8Array && chunk.byteLength === 0) continue;
      throw new SyncError("file_integrity_failed", "A file transport returned invalid bytes.");
    }
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || size > file.size) {
      throw new SyncError("file_integrity_failed", `Downloaded bytes for ${file.path} are oversized.`);
    }
    hash.update(chunk);
    yield chunk;
  }
  if (size !== file.size || `sha256:${bytesToHex(hash.digest())}` !== file.content_digest) {
    throw new SyncError(
      "file_integrity_failed",
      `Downloaded bytes for ${file.path} failed integrity verification.`
    );
  }
}

export async function* verifiedBinaryBytes(
  source: AsyncIterable<Uint8Array>,
  expected: MirrorBinaryInfo,
  path: string
): AsyncGenerator<Uint8Array> {
  const hash = sha256.create();
  let size = 0;
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) {
      throw new SyncError("file_integrity_failed", `Local bytes for ${path} are invalid.`);
    }
    if (chunk.byteLength === 0) continue;
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size) || size > expected.size) {
      throw new SyncError("pending_local_changed", `Local file ${path} changed while being staged.`);
    }
    hash.update(chunk);
    yield chunk;
  }
  if (size !== expected.size || `sha256:${bytesToHex(hash.digest())}` !== expected.content_digest) {
    throw new SyncError("pending_local_changed", `Local file ${path} changed while being staged.`);
  }
}

export async function ensureFileBlob(
  transport: SyncTransport,
  blobStore: MirrorBlobStore,
  file: CollectionFileDescriptor
): Promise<void> {
  validateCollectionFileDescriptor(file);
  if (await blobStore.has(file.content_digest)) {
    try {
      for await (const _chunk of verifiedFileBytes(
        blobStore.read(file.content_digest),
        file
      )) {
        // Drain the cache through the verifier before trusting it.
      }
      return;
    } catch {
      await blobStore.remove(file.content_digest);
    }
  }
  try {
    await blobStore.write(
      file.content_digest,
      verifiedFileBytes(transport.downloadFile(file), file)
    );
  } catch (error) {
    await blobStore.remove(file.content_digest).catch(() => undefined);
    throw error;
  }
  if (!await blobStore.has(file.content_digest)) {
    throw new SyncError("file_integrity_failed", "The verified file blob was not persisted.");
  }
}
