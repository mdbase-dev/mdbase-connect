const MAX_RETAINED_EDITOR_KEYS = 40;

/** Keep the live CodeMirror identity after fail-closed room termination. */
export function collaborationEditorKey(
  retained: Map<string, string>,
  sessionKey: string,
  expected: boolean,
  terminal: boolean,
  bindingEpoch?: number | "sync"
): string {
  if (bindingEpoch !== undefined) {
    if (!retained.has(sessionKey) && retained.size >= MAX_RETAINED_EDITOR_KEYS) {
      retained.delete(retained.keys().next().value!);
    }
    retained.set(sessionKey, `${sessionKey}:live:${bindingEpoch}`);
  }
  if (!expected) return sessionKey;
  const openingKey = `${sessionKey}:live:opening`;
  if (bindingEpoch === undefined && !terminal) return openingKey;
  return retained.get(sessionKey) ?? openingKey;
}
