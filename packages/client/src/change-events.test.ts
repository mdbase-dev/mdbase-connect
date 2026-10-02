import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHANGE_EVENT_KINDS, type CollectionChange as WireChange } from "@mdbase-dev/connect-protocol";
import { normalizeCollectionChange, normalizeChangesPage } from "./change-events.js";
import { MdbaseCollectionClient } from "./collection-client.js";

const fixture = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/collection-changes-v1.json", import.meta.url), "utf8")) as {
  local: WireChange[]; hosted: WireChange[]; files: WireChange[];
};

describe("canonical change events", () => {
  for (const provider of ["local", "hosted", "files"] as const) {
    for (const raw of fixture[provider]) {
      it(`normalizes ${provider} ${raw.type} and retains the exact wire event`, () => {
        const change = normalizeCollectionChange(raw);
        expect(change.kind).toBe(CHANGE_EVENT_KINDS[raw.type as keyof typeof CHANGE_EVENT_KINDS]);
        expect(change.raw).toBe(raw);
        expect(change.payload).toBe(raw.payload);
        expect(change).toMatchObject({ cursor: raw.cursor, type: raw.type, occurredAt: raw.occurred_at });
      });
    }
  }
  it("exposes local revision/type transitions without inventing hosted frontmatter", () => {
    const updated = normalizeCollectionChange(fixture.local[1]);
    expect(updated).toMatchObject({ kind: "record.updated", path: "note.md", previousRevision: "r1", revision: "r2",
      previousTypes: ["note"], types: ["task"], changedFields: ["/status", "/title"], bodyChanged: false });
    expect(updated).not.toHaveProperty("before");
    expect(updated).not.toHaveProperty("after");
    const deleted = normalizeCollectionChange(fixture.local[2]);
    expect(deleted).toMatchObject({ kind: "record.deleted", previousRevision: "r2", previousTypes: ["task"], types: [] });
    expect(deleted).not.toHaveProperty("revision");
  });
  it("preserves hosted frontmatter and does not infer bodyChanged or deletion type semantics", () => {
    expect(normalizeCollectionChange(fixture.hosted[1])).toMatchObject({ before: { title: "Old" }, after: { title: "New" }, changedFields: ["title"] });
    const deleted = normalizeCollectionChange(fixture.hosted[2]);
    expect(deleted).toMatchObject({ kind: "record.deleted", types: ["note"] });
    expect(deleted).not.toHaveProperty("previousTypes");
    expect(deleted).not.toHaveProperty("bodyChanged");
  });
  it("normalizes file descriptors and file identity", () => {
    expect(normalizeCollectionChange(fixture.files[0])).toMatchObject({ kind: "file.put", file: {
      fileId: "01911111-1111-7111-8111-111111111111", contentDigest: expect.stringMatching(/^sha256:/), mediaClass: "image", modifiedAt: "2026-08-04T00:00:00Z"
    } });
    expect(normalizeCollectionChange(fixture.files[1])).toMatchObject({ kind: "file.removed", fileId: "01911111-1111-7111-8111-111111111111", previousPath: "Assets/image.png" });
  });
  it("accepts minimal events from older authorities without metadata inference", () => {
    const raw = { cursor: 1, type: "mdbase.record.modified", occurred_at: "now", payload: { path: "note.md" } };
    expect(normalizeCollectionChange(raw)).toEqual({ cursor: 1, type: raw.type, occurredAt: "now", payload: raw.payload, raw, kind: "record.updated", path: "note.md" });
  });
  it("passes unknown IDs and malformed known payloads through explicitly", () => {
    for (const [type, payload, reason] of [
      ["future.event", { rich: [1, 2] }, "unrecognized_type"],
      ["mdbase.record.modified", {}, "invalid_payload"],
      ["mdbase.record.renamed", { to: "note.md" }, "invalid_payload"],
      ["mdbase.record.modified", { path: "note.md", types: [42] }, "invalid_payload"],
      ["mdbase.file.put", { file: { file_id: "id" } }, "invalid_payload"]
    ] as const) {
      const raw = { cursor: 1, type, occurred_at: "now", payload: structuredClone(payload) } as WireChange;
      expect(normalizeCollectionChange(raw)).toMatchObject({ kind: "unknown", reason, raw });
    }
  });
  it("represents reset pages without inventing an authority event ID", () => {
    const raw = { events: [], cursor: 10, has_more: false, reset: true };
    expect(normalizeChangesPage(raw)).toMatchObject({ reset: true, events: [{ kind: "reset", cursor: 10, raw }] });
  });
  it("uses the same normalizer for changes and watch", async () => {
    const raw = fixture.hosted[1];
    const client = new MdbaseCollectionClient({ async operation<Result>() {
      return { events: [raw], cursor: 2, has_more: false, reset: false } as Result;
    } });
    const page = await client.changes({ after: 1 });
    const watch = client.watch({ cursor: 1 });
    const next = await watch.next();
    expect(next.value).toEqual(page.ok ? { ok: true, value: page.value.events[0], diagnostics: [] } : undefined);
    await watch.return();
  });
});
