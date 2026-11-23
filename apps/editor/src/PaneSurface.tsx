import type { ReactNode } from "react";
import type { FileAssetSnapshot, FileAssetStore } from "./file-asset-store";
import type { CollectionFile } from "./model";
import { useFileAsset } from "./use-file-assets";
import { useNoteSurface, type NoteSurface, type NoteSurfaceInput } from "./use-note-surface";

/** What one pane's editor reads for itself, so that any number of panes can be open: the surface around
 * its note and, for a pane without the focus, the file it shows instead of a note. */
export function PaneSurface({ surface, assets, file, children }: {
  surface: NoteSurfaceInput;
  assets: FileAssetStore;
  file: CollectionFile | undefined;
  children: (around: NoteSurface, asset: FileAssetSnapshot | undefined) => ReactNode;
}) {
  const around = useNoteSurface(surface);
  const asset = useFileAsset(assets, file);
  return children(around, asset);
}
