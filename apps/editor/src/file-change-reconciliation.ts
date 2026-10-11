import type { EditorCollectionChange } from "./model";
import type { FileAssetStore } from "./file-asset-store";
import type { FileInventoryController } from "./file-inventory-controller";

export function isFileChange(change: EditorCollectionChange): boolean {
  return change.kind === "file.put" || change.kind === "file.removed" || change.kind === "file.changed";
}

export function reconcileFileChange(
  change: EditorCollectionChange,
  inventory: FileInventoryController,
  assets: FileAssetStore
): void {
  if (change.kind === "file.put") {
    assets.invalidate(change.file.fileId);
    inventory.upsert(change.file);
  } else if (change.kind === "file.removed") {
    assets.invalidate(change.fileId);
    inventory.remove(change.fileId);
  }
}
