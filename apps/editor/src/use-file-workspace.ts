import { useEffect, useState } from "react";
import type { FileAssetSnapshot, FileAssetStore } from "./file-asset-store";
import type { CollectionFile } from "./model";
import { useEmbeddedFileAssets, useFileAsset } from "./use-file-assets";

export function useFileWorkspace(
  store: FileAssetStore,
  files: readonly CollectionFile[],
  source: string,
  sourcePath?: string,
  visibleEmbedKeys?: ReadonlySet<string>
) {
  const [selectedFile, setSelectedFile] = useState<CollectionFile>();
  const [pendingFilePath, setPendingFilePath] = useState<string>();
  const [openAsset, setOpenAsset] = useState<Extract<FileAssetSnapshot, { status: "ready" }>>();
  const selectedAsset = useFileAsset(store, selectedFile);
  const embeddedFiles = useEmbeddedFileAssets(store, source, files, sourcePath, visibleEmbedKeys);

  useEffect(() => setOpenAsset(undefined), [sourcePath]);
  useEffect(() => openAsset ? store.acquire(openAsset.file) : undefined, [openAsset, store]);
  useEffect(() => {
    if (selectedAsset?.status !== "loading" && selectedAsset?.status !== "idle") setPendingFilePath(undefined);
  }, [selectedAsset?.status]);
  useEffect(() => {
    if (!selectedFile) return;
    const current = files.find((file) => file.fileId === selectedFile.fileId);
    if (!current) {
      setSelectedFile(undefined);
      setPendingFilePath(undefined);
    } else if (current.revision !== selectedFile.revision || current.path !== selectedFile.path) setSelectedFile(current);
  }, [files, selectedFile]);

  return { selectedFile, setSelectedFile, selectedAsset, pendingFilePath, setPendingFilePath, openAsset, setOpenAsset, embeddedFiles };
}
