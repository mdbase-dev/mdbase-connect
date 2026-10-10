import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyScalarEdits, minimalChange, ObsidianEditorFence, scalarToUtf16, type EditorLike, type MarkdownViewLike, type WorkspaceLike } from "../src/fence/editorFence.js";

class FakeEditor implements EditorLike {
  txs: string[] = [];
  onGet: (() => void) | null = null;
  constructor(public buf: string) {}
  getValue() {
    const v = this.buf;
    this.onGet?.();
    return v;
  }
  offsetToPos(o: number) {
    const before = this.buf.slice(0, o);
    const line = before.split("\n").length - 1;
    return { line, ch: o - (before.lastIndexOf("\n") + 1) };
  }
  posToOffset(p: { line: number; ch: number }) {
    const lines = this.buf.split("\n");
    let o = 0;
    for (let i = 0; i < p.line; i++) o += lines[i]!.length + 1;
    return o + p.ch;
  }
  transaction(tx: { changes: { from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }[] }, origin?: string) {
    for (const c of tx.changes) {
      const f = this.posToOffset(c.from);
      const t = c.to ? this.posToOffset(c.to) : f;
      this.buf = this.buf.slice(0, f) + c.text + this.buf.slice(t);
    }
    this.txs.push(origin ?? "");
  }
}

function view(path: string, buf: string, saved = buf, priv = true): MarkdownViewLike & { editor: FakeEditor } {
  const v: MarkdownViewLike & { editor: FakeEditor } = { file: { path }, editor: new FakeEditor(buf) };
  if (priv) Object.assign(v, { dirty: buf !== saved, saving: false, lastSavedData: saved });
  return v;
}
function ws(views: MarkdownViewLike[]): WorkspaceLike {
  return { getLeavesOfType: () => views.map((view) => ({ view })), on: () => ({}), offref: () => {} };
}
const H = (s: string) => new Uint8Array(createHash("sha256").update(Buffer.from(s, "utf8")).digest());

describe("offset helpers", () => {
  it("maps Unicode scalar offsets over surrogate pairs", () => {
    const s = "a😀b😀c";
    expect(scalarToUtf16(s, [0, 1, 2, 3, 4, 5])).toEqual([0, 1, 3, 4, 6, 7]);
    expect(applyScalarEdits(s, [[2, 3, "B"], [4, 5, "C!"]])).toBe("a😀B😀C!");
    expect(() => applyScalarEdits(s, [[0, 2, ""], [1, 3, ""]])).toThrow();
  });
  it("minimal change keeps common prefix and suffix and never splits a pair", () => {
    expect(minimalChange("status: open\nbody", "status: done\nbody")).toEqual({ from: 8, to: 12, text: "done" });
    expect(minimalChange("x😀", "x😁")).toEqual({ from: 1, to: 3, text: "😁" });
    expect(minimalChange("same", "same")).toBeNull();
  });
});

describe("fence_apply (contract §14)", () => {
  const doc = "---\nstatus: open\n---\nbody\n";
  const edits = [[12, 16, "done"]] as const;
  const want = "---\nstatus: done\n---\nbody\n";

  it("applies a minimal transaction when the buffer is at base", async () => {
    const v = view("t.md", doc);
    const f = new ObsidianEditorFence(ws([v]), "1.13.8");
    expect(await f.applyEdits("t.md", H(doc), edits, H(want))).toEqual({ status: "applied" });
    expect(v.editor.buf).toBe(want);
    expect(v.editor.txs).toEqual(["mdbase.sync"]);
  });

  it("returns the buffer when the user has typed", async () => {
    const v = view("t.md", doc + "typing", doc);
    const f = new ObsidianEditorFence(ws([v]), "1.13.8");
    expect(await f.applyEdits("t.md", H(doc), edits, H(want))).toEqual({ status: "buffer_changed", buffer: doc + "typing" });
    expect(v.editor.txs).toEqual([]);
  });

  it("re-checks synchronously: a keystroke during hashing wins", async () => {
    const v = view("t.md", doc);
    let first = true;
    v.editor.onGet = () => {
      if (first) {
        first = false;
        queueMicrotask(() => (v.editor.buf = doc + "x"));
      }
    };
    const f = new ObsidianEditorFence(ws([v]), "1.13.8");
    const r = await f.applyEdits("t.md", H(doc), edits, H(want));
    expect(r.status).toBe("buffer_changed");
    expect(v.editor.buf).toBe(doc + "x");
  });

  it("not_open when no editor has the file; split views are applied once", async () => {
    const a = view("t.md", doc);
    const f0 = new ObsidianEditorFence(ws([a]), "1.13.8");
    expect(await f0.applyEdits("other.md", H(doc), edits, H(want))).toEqual({ status: "not_open" });
    const b = view("t.md", want); // a linked split view already showing the result
    const f = new ObsidianEditorFence(ws([a, b]), "1.13.8");
    expect(await f.applyEdits("t.md", H(doc), edits, H(want))).toEqual({ status: "applied" });
    expect(b.editor.txs).toEqual([]);
  });
});

describe("EditorFence trait form (base, new)", () => {
  const merge = (base: string, ours: string, theirs: string) => {
    // toy line merge: apply theirs' changed lines onto ours where ours didn't change them
    const b = base.split("\n"), o = ours.split("\n"), t = theirs.split("\n");
    if (b.length !== o.length || b.length !== t.length) return null;
    const out = b.map((line, i) => (t[i] !== line && o[i] !== line ? null : t[i] !== line ? t[i]! : o[i]!));
    return out.includes(null) ? null : out.join("\n");
  };
  it("merges with unsaved typing on other lines", async () => {
    const v = view("t.md", "a\nb USER\nc", "a\nb\nc");
    const f = new ObsidianEditorFence(ws([v]), "1.13.8", merge);
    expect(await f.apply("t.md", "a\nb\nc", "A\nb\nc")).toEqual({ kind: "Applied" });
    expect(v.editor.buf).toBe("A\nb USER\nc");
  });
  it("conflicts when the change overlaps the user's line", async () => {
    const v = view("t.md", "a\nb USER\nc", "a\nb\nc");
    const f = new ObsidianEditorFence(ws([v]), "1.13.8", merge);
    expect(await f.apply("t.md", "a\nb\nc", "a\nB\nc")).toEqual({ kind: "Conflict", buffer: "a\nb USER\nc" });
    expect(v.editor.buf).toBe("a\nb USER\nc");
  });
});

describe("dirty state", () => {
  it("uses lastSavedData on pinned versions", () => {
    const f = new ObsidianEditorFence(ws([view("t.md", "typed", "saved")]), "1.13.8");
    expect(f.state("t.md")).toEqual({ kind: "Open", dirty: true });
    expect(f.state("x.md")).toEqual({ kind: "Closed" });
  });
  it("probes unpinned versions and falls back to Unknown when fields are missing", () => {
    expect(new ObsidianEditorFence(ws([view("t.md", "a")]), "1.99.0").state("t.md")).toEqual({ kind: "Open", dirty: false });
    expect(new ObsidianEditorFence(ws([view("t.md", "a", "a", false)]), "1.99.0").state("t.md")).toEqual({ kind: "Unknown" });
  });
  it("reports open files with hashes", async () => {
    const f = new ObsidianEditorFence(ws([view("t.md", "x", "y"), view("t.md", "x", "y")]), "1.13.8");
    const r = await f.report();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ path: "t.md", dirty: true });
    expect(Buffer.from(r[0]!.bufferHash).equals(Buffer.from(H("x")))).toBe(true);
  });
});
