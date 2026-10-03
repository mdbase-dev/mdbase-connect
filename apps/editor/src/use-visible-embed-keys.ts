import { useCallback, useState } from "react";

const EMPTY: ReadonlySet<string> = new Set();

export function useVisibleEmbedKeys(documentPath?: string) {
  const [visible, setVisible] = useState<{ path?: string; files: ReadonlySet<string>; notes: ReadonlySet<string> }>(() => ({ path: documentPath, files: EMPTY, notes: EMPTY }));
  const update = useCallback((kind: "files" | "notes", keys: string[]) => {
    setVisible(current => {
      const owned = current.path === documentPath ? current : { path: documentPath, files: EMPTY, notes: EMPTY };
      return owned[kind].size === keys.length && keys.every(key => owned[kind].has(key)) ? owned : { ...owned, [kind]: new Set(keys) };
    });
  }, [documentPath]);
  const updateFiles = useCallback((keys: string[]) => update("files", keys), [update]);
  const updateNotes = useCallback((keys: string[]) => update("notes", keys), [update]);
  // Derive the empty view immediately. A parent reset effect must not erase a
  // new document's visibility notification from a child effect in the same commit.
  return { files: visible.path === documentPath ? visible.files : EMPTY,
    notes: visible.path === documentPath ? visible.notes : EMPTY, updateFiles, updateNotes };
}
