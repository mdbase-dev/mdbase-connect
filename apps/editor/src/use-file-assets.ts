import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FileAssetStore, type FileAssetSnapshot } from "./file-asset-store";
import { fileReferences, isInlinePreviewable, type FileReference } from "./file-references";
import type { CollectionFile, CollectionGateway } from "./model";

export interface ResolvedFileReference extends Omit<FileReference, "file"> {
  file: CollectionFile;
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
  sourcePath?: string,
  visibleKeys?: ReadonlySet<string>
): ResolvedFileReference[] {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  const references = useMemo(
    () => fileReferences(source, files, sourcePath)
      .filter((reference): reference is FileReference & { file: CollectionFile } => Boolean(reference.file)),
    [files, source, sourcePath]
  );
  const acquired = references.filter(({ file }) => (
    isInlinePreviewable(file) && (!visibleKeys || visibleKeys.has(`${file.fileId}:${file.revision}`))
  ));
  const key = acquired.map(({ file }) => `${file.fileId}:${file.revision}`).join("\n");
  useEffect(() => {
    const releases = acquired.map(({ file }) => store.acquire(file));
    return () => { for (const release of releases) release(); };
    // key captures file identity, revision, and viewport membership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, store]);
  return references.map((reference) => ({ ...reference, asset: store.get(reference.file) }));
}
