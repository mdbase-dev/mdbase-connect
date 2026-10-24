// Shared bounded-source fixture for Node and workerd executor tests. Each
// hydration invalidates previous opaque file refs, like the real source reader.
const page = (rows, next = null) => ({ rows, next, done: next === null, collection: "c", S0: 40, holdExpiresAt: "2027-01-01T00:00:00Z" });
export const placement = (kind, key) => ({ kind, key, path: key, size: 3, hash: "0".repeat(64) });
export const fileRow = (id, size = 3) => ({ fileId: id, path: `${id}.bin`, contentDigest: "d", size, mediaType: null, mediaClass: "binary", sequence: 1, sourceRef: `ref-${id}` });
export const recordRow = id => ({ recordId: id, path: `${id}.md`, revision: "r", sequence: 1, documentBytes: 2, document: "{}", contentRef: null });
export const LARGE_RECORD_TEXT = "\ufeff" + "🙂".repeat(((1 << 20) - 4) / 4) + "x";
export function fakeSource(tables, recordBoundary = async () => {}) {
  const calls = [];
  let refs = new Map(), records = new Map();
  return {
    calls,
    async openCheckpoint(req) { calls.push(["open", req.S0, req.expectedState, req.backupHold]); return { session: "s1" }; },
    async nextPage(_id, table, cursor, limits) {
      calls.push(["page", table, cursor, limits.maxRecords, limits.maxDecodedBytes]);
      const pages = tables[table] ?? [[]], at = cursor === null ? 0 : Number(cursor);
      return page(pages[at], at + 1 < pages.length ? String(at + 1) : null);
    },
    async hydrateKeys(_id, table, keys, limits) {
      calls.push(["hydrate", table, keys.join(","), limits.maxRecords, limits.maxDecodedBytes]);
      const rows = (tables[table] ?? []).flat().filter(r => keys.includes(r.fileId ?? r.recordId ?? r.path)).slice(0, 1);
      refs = new Map(table === "files" ? rows.map(r => [r.sourceRef, r.size]) : []);
      records = new Map(table === "records" ? rows.filter(r => r.contentRef).map(r => [r.contentRef, r.documentBytes]) : []);
      return page(rows, rows.length < keys.length ? "more" : null);
    },
    async streamContent(_id, ref) {
      calls.push(["stream", ref]);
      if (!refs.has(ref)) throw new Error("file_ref_invalidated");
      let remaining = refs.get(ref);
      return new ReadableStream({ pull(c) {
        if (!remaining) { c.close(); return; }
        const n = Math.min(remaining, 1 << 20); remaining -= n; c.enqueue(new Uint8Array(n).fill(0x5c));
      } });
    },
    async streamRecord(_id, ref) {
      calls.push(["stream-record", ref]);
      if (!records.has(ref)) throw new Error("record_ref_invalidated");
      const bytes = new TextEncoder().encode(LARGE_RECORD_TEXT);
      let offset = 0;
      return new ReadableStream({ async pull(c) {
        if (offset === bytes.length) { bytes.fill(0); c.close(); return; }
        const part = bytes.slice(offset, offset + (64 << 10)); offset += part.length;
        await recordBoundary(); c.enqueue(part);
      }, cancel() { bytes.fill(0); } });
    },
    async close(id) { calls.push(["close", id]); },
  };
}
export function gen0Source(recordBoundary) {
  return fakeSource({ resources: [[{ path: "p", kind: "type", revision: "r", document: new Uint8Array(1) },
    { path: "q", kind: "type", revision: "r", document: new Uint8Array(1) }]],
    files: [[fileRow("f1", (8 << 20) + 17)]], records: [[recordRow("a"),
      { ...recordRow("b"), documentBytes: 1 << 20, document: null, contentRef: "text-b" }]] }, recordBoundary);
}
export function gen0Plan(created, routed) {
  return [
    { kind: 2, fields: [0, 40], step: created, settle: "source" },
    { kind: 4, fields: [1, null, null], placements: [placement(0, "p")], done: false, step: created, settle: "gen0" },
    { kind: 4, fields: [1, null, "p"], placements: [placement(0, "q")], step: created, settle: "gen0" },
    { kind: 4, fields: [1, 0, null], placements: [placement(2, "f1"), placement(1, "a")], done: false, step: created, settle: "gen0" },
    { kind: 4, fields: [1, 0, "a"], placements: [placement(1, "b")], step: created, settle: "gen0" },
    { kind: 5, step: routed, settle: "gen0" },
  ];
}
