import type { CollectionChange } from "@mdbase-dev/connect";
import type { FileAssetStore } from "./file-asset-store";
import type { FileInventoryController } from "./file-inventory-controller";
import type { CollectionFile } from "./model";

export function isFileChange(change: CollectionChange): boolean {
  return change.type.startsWith("mdbase.file.") || change.type === "file_put" || change.type === "file_remove";
}

export function reconcileFileChange(
  change: CollectionChange,
  inventory: FileInventoryController,
  assets: FileAssetStore
): void {
  const payload = change.payload;
  const fileValue = payload.file;
  const file = collectionFile(fileValue);
  if ((change.type === "mdbase.file.put" || change.type === "file_put") && file) {
    assets.invalidate(file.fileId);
    inventory.upsert(file);
    return;
  }
  const fileId = typeof payload.file_id === "string"
    ? payload.file_id
    : typeof payload.fileId === "string"
      ? payload.fileId
      : file?.fileId;
  if (fileId && (change.type === "mdbase.file.remove" || change.type === "file_remove")) {
    assets.invalidate(fileId);
    inventory.remove(fileId);
  }
}

function collectionFile(value: unknown): CollectionFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  const fileId = stringValue(file.fileId, file.file_id);
  const contentDigest = stringValue(file.contentDigest, file.content_digest);
  const mediaClass = stringValue(file.mediaClass, file.media_class);
  const modifiedAt = stringValue(file.modifiedAt, file.modified_at);
  if (!fileId || typeof file.path !== "string" || typeof file.revision !== "string"
    || !contentDigest?.startsWith("sha256:") || typeof file.size !== "number"
    || !isMediaClass(mediaClass) || !modifiedAt) return null;
  const mediaType = stringValue(file.mediaType, file.media_type);
  return {
    fileId,
    path: file.path,
    revision: file.revision,
    contentDigest: contentDigest as `sha256:${string}`,
    size: file.size,
    ...(mediaType ? { mediaType } : {}),
    mediaClass,
    modifiedAt
  };
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function isMediaClass(value: string | undefined): value is CollectionFile["mediaClass"] {
  return value === "image" || value === "audio" || value === "video" || value === "pdf" || value === "other";
}
