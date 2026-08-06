import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FileAssetStore, type FileAssetSnapshot } from "./file-asset-store";
import { fileReferences, isInlinePreviewable, type FileReference } from "./file-references";
import type { CollectionFile, CollectionGateway } from "./model";

export interface ResolvedFileReference extends FileReference {
  asset: FileAssetSnapshot;
}

export function useFileAssetStore(gateway: CollectionGateway): FileAssetStore {
  const store = useMemo(() => new FileAssetStore(gateway), [gateway]);
  useEffect(() => () => store.reset(), [store]);
  return store;
}

export function useFileAsset(
  store: FileAssetStore,
  file: CollectionFile | undefined
): FileAssetSnapshot | undefined {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  useEffect(() => file ? store.acquire(file) : undefined, [file, store]);
  return file ? store.get(file) : undefined;
}

export function useEmbeddedFileAssets(
  store: FileAssetStore,
  source: string,
  files: readonly CollectionFile[],
  sourcePath?: string
): ResolvedFileReference[] {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const references = useMemo(
    () => fileReferences(source, files, sourcePath)
      .filter((reference): reference is FileReference & { file: CollectionFile } => Boolean(reference.file && isInlinePreviewable(reference.file))),
    [files, source, sourcePath]
  );
  const key = references.map(({ file }) => `${file.fileId}:${file.revision}`).join("\n");
  useEffect(() => {
    const releases = references.map(({ file }) => store.acquire(file));
    return () => { for (const release of releases) release(); };
  }, [key, store]);
  return references.map((reference) => ({ ...reference, asset: store.get(reference.file) }));
}
