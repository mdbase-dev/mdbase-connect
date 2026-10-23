/** Stable union: identical generated IDs deduplicate; conflicting values fail closed. */
/**
 * @param {readonly { messages: object }[]} catalogues
 * @returns {{ messages: object }}
 */
export function mergeCatalogues(catalogues) {
  /** @param {unknown} value @returns {unknown} */
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
    return value;
  };
  const messages = new Map();
  const conflicts = new Set();
  for (const catalogue of catalogues) for (const [id, value] of Object.entries(catalogue.messages)) {
    const normalized = canonical(value);
    if (messages.has(id) && JSON.stringify(messages.get(id)) !== JSON.stringify(normalized)) {
      conflicts.add("Conflicting compiled translation for message ID: " + id +
        " — " + JSON.stringify(messages.get(id)) + " vs " + JSON.stringify(normalized));
    } else messages.set(id, normalized);
  }
  if (conflicts.size) throw new Error([...conflicts].join("\n"));
  return { messages: Object.fromEntries([...messages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}
