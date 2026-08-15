import { useCallback, useEffect, useState } from "react";

export function useVisibleEmbedKeys(documentPath?: string) {
  const [files, setFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [notes, setNotes] = useState<ReadonlySet<string>>(() => new Set());
  const updateFiles = useCallback((keys: string[]) => {
    setFiles((current) => sameStringSet(current, keys) ? current : new Set(keys));
  }, []);
  const updateNotes = useCallback((keys: string[]) => {
    setNotes((current) => sameStringSet(current, keys) ? current : new Set(keys));
  }, []);
  useEffect(() => {
    setFiles(new Set());
    setNotes(new Set());
  }, [documentPath]);
  return { files, notes, updateFiles, updateNotes };
}

function sameStringSet(current: ReadonlySet<string>, next: readonly string[]): boolean {
  return current.size === next.length && next.every((value) => current.has(value));
}
