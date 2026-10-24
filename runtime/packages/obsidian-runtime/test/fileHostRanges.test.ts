import { mkdir, mkdtemp, readFile, writeFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HostDriver } from "../src/host/driver.js";
import { VaultPlatform } from "../src/vault/platform.js";
import { openWholeFileRange } from "../src/vault/wholeFileRange.js";
import type { ObsAdapter, ObsApp } from "../src/vault/obsidianApi.js";
import type { DualJournal } from "../src/journal/dual.js";
import { checkRelPath, FsError } from "../src/vault/types.js";

// Real filesystem read adapter in an owned isolated fixture. No Obsidian app,
// fake record inventory, native FileStore/Rescan or power-loss proof is claimed.
const work = fileURLToPath(new URL("../../../target/obsidian-host-ranges/", import.meta.url));
async function fixture() {
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(resolve(work, "real-fs-"));
  const path = (rel: string) => { checkRelPath(rel === "/" ? "" : rel); return resolve(root, rel === "/" ? "" : rel); };
  const unsupported = () => { throw new FsError("Unsupported", "unused fixture operation"); };
  const adapter: ObsAdapter = {
    async exists(rel) { try { await lstat(path(rel)); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } },
    async stat(rel) {
      try {
        const s = await lstat(path(rel));
        if (!s.isFile() && !s.isDirectory()) throw new FsError("Unsupported", "nonregular fixture source");
        return { type: s.isFile() ? "file" : "folder", size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    },
    async readBinary(rel) { const b = await readFile(path(rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
    async read(rel) { return readFile(path(rel), "utf8"); },
    async mkdir(rel) { await mkdir(path(rel)); },
    async write(rel, data) { await writeFile(path(rel), data); },
    async writeBinary(rel, data) { await writeFile(path(rel), new Uint8Array(data)); },
    getBasePath: () => root,
    list: unsupported, process: unsupported, remove: unsupported, rename: unsupported,
  };
  const app: ObsApp = {
    vault: { adapter, getAbstractFileByPath: unsupported, process: unsupported, create: unsupported,
      createBinary: unsupported, rename: unsupported, on: unsupported, offref: unsupported },
    fileManager: { trashFile: unsupported },
  };
  const vault = new VaultPlatform(app, { root: "", platform: { isMobileApp: false, isAndroidApp: false, isIosApp: false }, wholeFileRangeMaxBytes: 1024 * 1024 });
  // File requests never touch this journal; an unexpected journal request refuses.
  const journal = { load: unsupported, append: unsupported, compact: unsupported } as unknown as DualJournal;
  return { root, adapter, app, vault, driver: new HostDriver(vault, journal, null) };
}

describe("real HostDriver whole-file range provider", () => {
  it("reads all exact eight original resource files through owned range handles", async () => {
    const { root, driver, vault } = await fixture();
    const bundle = JSON.parse(await readFile(fileURLToPath(new URL("../../../crates/local-host/tests/fixtures/reader-semantic-digests/bundle.json", import.meta.url)), "utf8")) as { resources: { path: string; document: string }[] };
    expect(bundle.resources).toHaveLength(8);
    try {
      for (const r of bundle.resources) {
        checkRelPath(r.path);
        await mkdir(resolve(root, r.path, ".."), { recursive: true });
        await writeFile(resolve(root, r.path), r.document);
        const opened = await driver.perform({ kind: "File", op: { op: "OpenRangeRead", path: r.path } });
        if (opened.kind !== "File" || !opened.result.ok || opened.result.value.kind !== "Range") throw new Error("genuine open required");
        const { handle, meta } = opened.result.value.value;
        expect(meta.id).toBeNull();
        expect(meta.size).toBe(Buffer.byteLength(r.document));
        const bytes = await driver.perform({ kind: "File", op: { op: "ReadAt", handle, offset: 0, len: meta.size } });
        if (bytes.kind !== "File" || !bytes.result.ok || bytes.result.value.kind !== "Bytes") throw new Error("genuine read required");
        expect(Buffer.from(bytes.result.value.value).toString("utf8")).toBe(r.document);
        expect(await driver.perform({ kind: "File", op: { op: "RangeMeta", handle } })).toMatchObject({ kind: "File", result: { ok: true, value: { kind: "Meta", value: meta } } });
        expect(await driver.perform({ kind: "File", op: { op: "CloseRangeRead", handle } })).toEqual({ kind: "File", result: { ok: true, value: { kind: "Unit" } } });
        expect(await readFile(resolve(root, r.path), "utf8")).toBe(r.document);
        expect(await driver.perform({ kind: "File", op: { op: "ReadAt", handle, offset: 0, len: 1 } })).toMatchObject({ kind: "File", result: { ok: false, error: { kind: "BadHandle" } } });
      }
      console.log(`REAL_HOSTDRIVER_RANGE_FILES=8; qualification=host-file-primitives-only; root=${root}`);
    } finally { await vault.closeRangeReads(); }
  });

  it("refuses oversized sources before readBinary and requires explicit opt-in", async () => {
    const { root, adapter, app, vault } = await fixture();
    const disabled = new VaultPlatform(app, { root: "", platform: { isMobileApp: false, isAndroidApp: false, isIosApp: false } });
    expect(await disabled.perform({ op: "OpenRangeRead", path: "large.bin" })).toMatchObject({ ok: false, error: { kind: "Unsupported" } });
    await disabled.closeRangeReads();
    await writeFile(resolve(root, "large.bin"), new Uint8Array(33));
    let reads = 0;
    const measured = { stat: adapter.stat, readBinary: async (p: string) => { reads++; return adapter.readBinary(p); } };
    await expect(openWholeFileRange(measured, "large.bin", 32)).rejects.toMatchObject({ kind: "NoSpace" });
    expect(reads).toBe(0);
    await expect(openWholeFileRange(measured, "../outside", 32)).rejects.toMatchObject({ kind: "InvalidPath" });
    expect(reads).toBe(0);
    await vault.closeRangeReads();
  });

  it("detects changed bytes even when adapter metadata is unchanged", async () => {
    const { root, adapter, vault } = await fixture();
    await writeFile(resolve(root, "same.txt"), "old");
    const original = await adapter.stat("same.txt");
    const provider = await openWholeFileRange({ stat: async () => original, readBinary: adapter.readBinary }, "same.txt", 32);
    await writeFile(resolve(root, "same.txt"), "new");
    await expect(provider.readAt(0, 3)).rejects.toMatchObject({ kind: "Busy", detail: "source_changed" });
    await provider.close();
    await vault.closeRangeReads();
  });

  it("bounds live handles and invalidates every original handle on host shutdown", async () => {
    const { root, driver, vault } = await fixture();
    await writeFile(resolve(root, "empty.bin"), "");
    const handles = new Set<bigint>();
    try {
      for (let i = 0; i < 64; i++) {
        const result = await driver.perform({ kind: "File", op: { op: "OpenRangeRead", path: "empty.bin" } });
        if (result.kind !== "File" || !result.result.ok || result.result.value.kind !== "Range") throw new Error("genuine open required");
        handles.add(result.result.value.value.handle);
      }
      expect(handles.size).toBe(64);
      expect(await driver.perform({ kind: "File", op: { op: "OpenRangeRead", path: "empty.bin" } })).toMatchObject({ kind: "File", result: { ok: false, error: { kind: "NoSpace" } } });
      await vault.closeRangeReads();
      for (const handle of handles)
        expect(await driver.perform({ kind: "File", op: { op: "RangeMeta", handle } })).toMatchObject({ kind: "File", result: { ok: false, error: { kind: "BadHandle" } } });
    } finally { await vault.closeRangeReads(); }
  });

  it("close during real read delivery refuses late bytes and retains cleanup ownership", async () => {
    const { root, adapter, vault } = await fixture();
    await writeFile(resolve(root, "late.txt"), "real bytes");
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let reads = 0;
    const provider = await openWholeFileRange({ stat: adapter.stat, readBinary: async p => {
      const bytes = await adapter.readBinary(p);
      if (++reads === 2) { entered(); await gate; }
      return bytes;
    } }, "late.txt", 32);
    const reading = provider.readAt(0, 4);
    const failure = expect(reading).rejects.toMatchObject({ kind: "BadHandle" });
    await started;
    let closed = false;
    const closing = provider.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await failure;
    await closing;
    await vault.closeRangeReads();
  });
});
