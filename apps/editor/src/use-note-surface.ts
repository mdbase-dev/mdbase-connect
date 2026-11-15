import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { useBacklinks, useLinkTargets } from "./collection-links";
import type { FileAssetStore } from "./file-asset-store";
import type { CollectionFile, CollectionGateway, NoteSummary } from "./model";
import { useEmbeddedNoteReferences, type EmbedCacheOwner } from "./note-embeds";
import { useEmbeddedFileAssets } from "./use-file-assets";
import { useVisibleEmbedKeys } from "./use-visible-embed-keys";

interface NoteSurfaceInput {
  gateway: CollectionGateway;
  assets: FileAssetStore;
  owner: EmbedCacheOwner;
  /** The saved note an editor shows; a new note has no path yet. */
  path: string | undefined;
  /** The text the editor shows, edits included. */
  source: string;
  revision: number;
  files: readonly CollectionFile[];
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
}

/** What one editor shows around its note's text: where its links go, the files and notes it embeds, and
 * the notes that link to it. Each pane keeps its own, so moving the focus between panes changes none of it. */
export function useNoteSurface({ gateway, assets, owner, path, source, revision, files, notes, types }: NoteSurfaceInput) {
  const visible = useVisibleEmbedKeys(path);
  const linkTargets = useLinkTargets(gateway, path, revision, files);
  const embeddedFiles = useEmbeddedFileAssets(assets, source, files, linkTargets, visible.files);
  const embeddedNotes = useEmbeddedNoteReferences(gateway, owner, source, notes, linkTargets, visible.notes);
  const backlinks = useBacklinks(gateway, path, revision, notes, types);
  return { linkTargets, embeddedFiles, embeddedNotes, backlinks, updateVisibleFiles: visible.updateFiles, updateVisibleNotes: visible.updateNotes };
}
