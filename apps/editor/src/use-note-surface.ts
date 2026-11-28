import { useEffect, useState } from "react";
import type { CollectionTypeDescriptor } from "./connect-types";
import { useBacklinks, useLinkTargets } from "./collection-links";
import type { FileAssetStore } from "./file-asset-store";
import type { CollectionFile, CollectionGateway, NoteSummary } from "./model";
import { LARGE_NOTE_LENGTH } from "./note";
import { useEmbeddedNoteReferences, type EmbedCacheOwner } from "./note-embeds";
import { useEmbeddedFileAssets } from "./use-file-assets";
import { useVisibleEmbedKeys } from "./use-visible-embed-keys";

export interface NoteSurfaceInput {
  gateway: CollectionGateway;
  assets: FileAssetStore;
  owner: EmbedCacheOwner;
  /** The saved note an editor shows; a new note has no path yet. */
  path: string | undefined;
  documentKey: string | undefined;
  /** The text the editor shows, edits included. */
  source: string;
  revision: number;
  files: readonly CollectionFile[];
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
}

/** What one editor shows around its note's text: where its links go, the files and notes it embeds, and
 * the notes that link to it. Each pane keeps its own (see PaneSurface), so moving the focus between panes changes none of it. */
export function useNoteSurface({ gateway, assets, owner, path, documentKey, source, revision, files, notes, types }: NoteSurfaceInput) {
  const visible = useVisibleEmbedKeys(path);
  const linkTargets = useLinkTargets(gateway, path, revision, files);
  const [settled, setSettled] = useState({ documentKey, source });
  const large = source.length >= LARGE_NOTE_LENGTH;
  const sameNote = documentKey === settled.documentKey;
  // CodeMirror maps the visible embeds through edits. Let whole-note discovery
  // wait for a pause on long notes, keeping it off the keystroke's paint path.
  useEffect(() => {
    if ((!large && sameNote) || (sameNote && settled.source === source)) return;
    if (!sameNote) {
      setSettled({ documentKey, source });
      return;
    }
    const timer = setTimeout(() => setSettled({ documentKey, source }), 350);
    return () => clearTimeout(timer);
  }, [documentKey, large, sameNote, settled.source, source]);
  const embedSource = large && sameNote ? settled.source : source;
  const embeddedFiles = useEmbeddedFileAssets(assets, embedSource, files, linkTargets, visible.files);
  const embeddedNotes = useEmbeddedNoteReferences(gateway, owner, embedSource, notes, linkTargets, visible.notes, files);
  const backlinks = useBacklinks(gateway, path, revision, notes, types);
  return { linkTargets, embeddedFiles, embeddedNotes, backlinks, updateVisibleFiles: visible.updateFiles, updateVisibleNotes: visible.updateNotes };
}

export type NoteSurface = ReturnType<typeof useNoteSurface>;
