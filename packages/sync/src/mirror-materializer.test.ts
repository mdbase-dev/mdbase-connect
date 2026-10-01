import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MirrorMaterializer } from "./mirror-materializer.js";
import { MirrorDivergenceError } from "./sync-error.js";
import type { MirrorFileSystem, MirrorState } from "./mirror-state.js";
import type { SyncRecord } from "@mdbase-dev/connect-protocol";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(mode: "read_only" | "read_write", local: string | null, prior = local) {
  const record: SyncRecord = { record_id: "id", path: "note.md", document: "exact bytes\n", revision: "new", frontmatter: {}, body: "", types: [] };
  const state: MirrorState = { protocol_version: 1, replica_id: "replica", scope_epoch: 1, cursor: 0,
    records: prior === null ? {} : { id: { path: record.path, revision: "old", hash: digest(prior) } } };
  const files = new Map(local === null ? [] : [[record.path, local]]);
  const fs: MirrorFileSystem = {
    exists: async path => files.has(path),
    read: vi.fn(async path => files.get(path) ?? null),
    readText: vi.fn(async path => files.get(path) ?? null),
    write: vi.fn(async (path, value) => { files.set(path, value); }),
    move: async () => { throw new Error("unexpected move"); },
    remove: vi.fn(async path => { files.delete(path); }),
    listMarkdown: async () => [...files.keys()],
    inspectBinary: async () => null,
    writeBinary: async () => { throw new Error("unexpected binary write"); },
  };
  const runtimeDigest = vi.fn(digest);
  return { record, state, fs, files, runtimeDigest, materializer: new MirrorMaterializer(fs,
    { digest: runtimeDigest, randomId: () => "id", now: () => "2026-01-01T00:00:00Z" }, mode) };
}

describe.each(["read_only", "read_write"] as const)("%s materializer", mode => {
  it("advances metadata without rewriting identical bytes, without an accepted hash", async () => {
    const f = fixture(mode, "exact bytes\n");
    await f.materializer.put(f.state, f.record, { inspectionPreflighted: true });
    expect(f.fs.write).not.toHaveBeenCalled();
    expect(f.runtimeDigest).toHaveBeenCalledTimes(1);
    expect(f.state.records.id.revision).toBe("new");
    expect(f.state.records.id.hash).toBe(digest(f.record.document));
  });
  it("still writes changed owned bytes and missing files", async () => {
    for (const local of ["old", null]) {
      const f = fixture(mode, local);
      await f.materializer.put(f.state, f.record, { inspectionPreflighted: true });
      // The observed bytes are the conditional write's expectation.
      expect(f.fs.write).toHaveBeenCalledExactlyOnceWith("note.md", f.record.document, local);
    }
  });
  it("still rejects divergent local bytes unless their exact hash was accepted", async () => {
    const f = fixture(mode, "local edit", "old");
    await expect(f.materializer.put(f.state, f.record, { inspectionPreflighted: true })).rejects.toBeInstanceOf(MirrorDivergenceError);
    expect(f.fs.write).not.toHaveBeenCalled();
    await f.materializer.put(f.state, f.record, { inspectionPreflighted: true, acceptedHash: digest("local edit") });
    expect(f.fs.write).toHaveBeenCalledOnce();
  });
  it("repairs divergent bytes conditionally on the bytes it observed", async () => {
    const f = fixture(mode, "local edit", "old");
    await f.materializer.put(f.state, f.record, { inspectionPreflighted: 1 });
    expect(f.fs.write).toHaveBeenCalledExactlyOnceWith("note.md", f.record.document, "local edit");
  });
  it("repairs bytes that are not text with an unconditional write", async () => {
    const f = fixture(mode, null);
    f.fs.readText = vi.fn(async () => ({ kind: "invalid" as const, code: "invalid_utf8" as const, reason: "bad", revision: "sha256:x" as const }));
    await f.materializer.put(f.state, f.record, { inspectionPreflighted: 1 });
    expect(f.fs.write).toHaveBeenCalledExactlyOnceWith("note.md", f.record.document, undefined);
  });
});
