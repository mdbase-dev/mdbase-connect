import { useCallback, useEffect, useState } from "react";
import type { FileAssetSnapshot, FileAssetStore } from "./file-asset-store";
import { fileAssetKey } from "./file-reference-resolution";
import type { CollectionFile } from "./model";
import { useEmbeddedFileAssets, useFileAsset } from "./use-file-assets";

type ReadyAsset = Extract<FileAssetSnapshot, { status: "ready" }>;

export function useFileWorkspace(
  store: FileAssetStore,
  files: readonly CollectionFile[],
  source: string,
  sourcePath?: string,
  visibleEmbedKeys?: ReadonlySet<string>
) {
  // A store belongs to one gateway scope. Never carry selection or a cached URL
  // into another account/collection, even if its file IDs happen to match.
  const [selection, setSelection] = useState<{ store: FileAssetStore; file: CollectionFile }>();
  const [preview, setPreview] = useState<{ store: FileAssetStore; asset: ReadyAsset }>();
  const [pendingFilePath, setPendingFilePath] = useState<string>();
  const setSelectedFile = useCallback((file: CollectionFile | undefined) => {
    setSelection(file ? { store, file } : undefined);
  }, [store]);
  const setOpenAsset = useCallback((asset: ReadyAsset | undefined) => {
    setPreview(asset ? { store, asset } : undefined);
  }, [store]);

  const original = selection?.store === store ? selection.file : undefined;
  const current = original && files.find((file) => file.fileId === original.fileId);
  // Resolve against the actual inventory during render, not a later effect:
  // neither an old ready payload nor an old error may flash for new metadata.
  const selectedFile = current && (fileAssetKey(current) === fileAssetKey(original!) ? original : current);
  const selectedAsset = useFileAsset(store, selectedFile);
  const embeddedFiles = useEmbeddedFileAssets(store, source, files, sourcePath, visibleEmbedKeys);
  const candidate = preview?.store === store ? preview.asset : undefined;
  const listed = candidate && files.find((file) => file.fileId === candidate.file.fileId);
  const cached = candidate && store.get(candidate.file);
  const openAsset = candidate && listed && fileAssetKey(listed) === fileAssetKey(candidate.file)
    && cached?.status === "ready" && cached.url === candidate.url ? candidate : undefined;

  useEffect(() => setPreview(undefined), [sourcePath]);
  useEffect(() => openAsset ? store.acquire(openAsset.file) : undefined, [openAsset, store]);
  useEffect(() => {
    if (preview && !openAsset) setPreview(undefined);
  }, [openAsset, preview]);
  useEffect(() => {
    if (selectedAsset?.status !== "loading" && selectedAsset?.status !== "idle") setPendingFilePath(undefined);
  }, [selectedAsset?.status]);
  useEffect(() => {
    if (selection && (selection.store !== store || selection.file !== selectedFile)) {
      setSelection(selectedFile ? { store, file: selectedFile } : undefined);
      setPendingFilePath(undefined);
    }
  }, [selectedFile, selection, store]);

  return { selectedFile, setSelectedFile, selectedAsset, pendingFilePath, setPendingFilePath, openAsset, setOpenAsset, embeddedFiles };
}
