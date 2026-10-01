import { describe, expect, it, vi } from "vitest";
import { MemoryAuthority } from "./memory-authority.js";
import { WritableDirectoryMirror } from "./writable-directory-mirror.js";
import { MemoryMirrorStateStore } from "./memory-mirror-state.js";
import { portableMirrorRuntime } from "./mirror-state.js";
import * as format from "./mirror-format.js";

function fixture(count: number) {
  const authority = new MemoryAuthority();
  authority.seed(Array.from({ length: count }, (_, index) => ({
    record_id: `record-${index}`, path: `${index}.md`, frontmatter: { title: `Note ${index}` }, body: "Body\n", types: []
  })));
  const replica = authority.registerReplica({ name: "perf", mode: "read_write" });
  const files = new Map(authority.serialize().records.map(record => [record.path, record.document]));
  let digestCalls = 0;
  const runtime = { ...portableMirrorRuntime, digest: (document: string) => {
    if (document.startsWith("---\n")) digestCalls++;
    return portableMirrorRuntime.digest(document);
  }};
  const fileSystem = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path) ?? null,
    readText: async (path: string) => files.get(path) ?? null,
    write: async (path: string, document: string) => { files.set(path, document); },
    move: async () => undefined,
    remove: async () => undefined,
    listMarkdown: async () => [...files.keys()]
  };
  const mirror = new WritableDirectoryMirror(replica, authority.transport(replica), {
    fileSystem, stateStore: new MemoryMirrorStateStore(), runtime
  });
  return { mirror, files, reset: () => { digestCalls = 0; }, digestCalls: () => digestCalls };
}

describe("unchanged exact document inspection", () => {
  it("uses a verified common document instead of hashing/parsing it again", async () => {
    const { mirror, files, reset, digestCalls } = fixture(1_000);
    expect((await mirror.sync()).status).toBe("applied");
    reset();
    const classify = vi.spyOn(format, "classifyLocalRecord");
    try {
      const unchanged = await mirror.review();
      expect(unchanged.plan.actions).toEqual([]);
      expect(digestCalls()).toBe(0);
      expect(classify).not.toHaveBeenCalled();
      // A same-size edit still reads the bytes and must be hashed/classified.
      files.set("0.md", files.get("0.md")!.replace("Note 0", "Note X"));
      const edited = await mirror.review();
      expect(edited.plan.summary.uploads).toBe(1);
      expect(digestCalls()).toBeGreaterThan(0);
      expect(classify).toHaveBeenCalledTimes(1);
    } finally {
      classify.mockRestore();
    }
  });

  it("keeps structural warnings for unchanged opaque authority documents", async () => {
    const authority = new MemoryAuthority();
    const document = "---\nbroken: [\n---\nBody\n";
    authority.seed([{ record_id: "opaque", path: "opaque.md", frontmatter: {}, body: document, document, types: [] }]);
    const replica = authority.registerReplica({ name: "opaque", mode: "read_write" });
    const files = new Map([["opaque.md", document]]);
    const mirror = new WritableDirectoryMirror(replica, authority.transport(replica), {
      stateStore: new MemoryMirrorStateStore(),
      fileSystem: {
        exists: async (path) => files.has(path), read: async (path) => files.get(path) ?? null,
        readText: async (path) => files.get(path) ?? null, write: async (path, value) => { files.set(path, value); },
        move: async () => undefined, remove: async () => undefined, listMarkdown: async () => [...files.keys()]
      }
    });
    expect((await mirror.sync()).status).toBe("applied");
    const { plan } = await mirror.review();
    expect(plan.actions).toEqual([]);
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: "invalid_frontmatter", blocking: false, path: "opaque.md" }));
    expect(files.get("opaque.md")).toBe(document);
  });
});
