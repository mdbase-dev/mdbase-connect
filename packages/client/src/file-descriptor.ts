import type { CollectionFileDescriptor as WireFile } from "@mdbase-dev/connect-protocol";
import { connectError } from "./errors.js";
import { SHA256_DIGEST } from "./file-transfer-internals.js";

// Match files.v1's UUID format (including nil), not crypto transfer-version rules.
export const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  mediaClass: import("@mdbase-dev/connect-protocol").FileMediaClass;
  modifiedAt: string;
}

export function validFileDescriptor(value: unknown): value is WireFile {
  if (!value || typeof value !== "object") return false;
  const file = value as WireFile;
  return typeof file.file_id === "string" && FILE_ID.test(file.file_id)
    && typeof file.path === "string" && typeof file.revision === "string"
    && typeof file.content_digest === "string" && SHA256_DIGEST.test(file.content_digest)
    && Number.isSafeInteger(file.size) && file.size >= 0
    && ["image", "audio", "video", "pdf", "other"].includes(file.media_class)
    && typeof file.modified_at === "string" && (file.media_type === undefined || typeof file.media_type === "string");
}

export function clientFileDescriptor(file: WireFile): CollectionFileDescriptor {
  if (!validFileDescriptor(file)) throw connectError("invalid_operation_response", "The authority returned an invalid file descriptor.");
  return {
    fileId: file.file_id,
    path: file.path,
    revision: file.revision,
    contentDigest: file.content_digest,
    size: file.size,
    ...(file.media_type ? { mediaType: file.media_type } : {}),
    mediaClass: file.media_class,
    modifiedAt: file.modified_at
  };
}
