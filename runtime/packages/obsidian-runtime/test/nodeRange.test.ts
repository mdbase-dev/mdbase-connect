import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRangeBackend } from "../src/attachments/nodeRange.js";
import { BoundedRangeSource } from "../src/attachments/range.js";

const work = resolve(dirname(fileURLToPath(import.meta.url)), "../e2e/.work/range-tests");
async function fixture<T>(run: (dir: string) => Promise<T>): Promise<T> {
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, "[test]-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("actual native handle range IO (not root/path or staged-publication qualification)", () => {
  it("uses the opened inode, never a substituted pathname", async () => fixture(async dir => {
    const path = join(dir, "source.bin");
    const original = await open(path, "w+");
    await original.writeFile(new Uint8Array([1, 2, 3, 4]));
    // Substitution BEFORE the source snapshot: resolver owns capture timing.
    await rename(path, join(dir, "original.bin"));
    const replacement = await open(path, "w+");
    await replacement.writeFile(new Uint8Array([9, 9, 9, 9]));
    await replacement.close();
    const source = await BoundedRangeSource.open(nodeRangeBackend(original));
    try {
      const lease = await source.readAt(0, 4);
      expect([...lease.bytes]).toEqual([1, 2, 3, 4]);
      lease.release();
    } finally { await source.close(); }
  }));
  it("detects actual in-place edits after snapshot", async () => fixture(async dir => {
    const path = join(dir, "source.bin");
    const handle = await open(path, "w+");
    await handle.writeFile(new Uint8Array([1, 2, 3]));
    const source = await BoundedRangeSource.open(nodeRangeBackend(handle));
    const writer = await open(path, "r+");
    await writer.truncate(2);
    await writer.close();
    try { await expect(source.readAt(0, 2)).rejects.toMatchObject({ code: "source_changed" }); }
    finally { await source.close(); }
  }));
  it("rejects non-regular handles and closes them", async () => fixture(async dir => {
    if (process.platform === "win32") return; // Windows does not open a directory as a FileHandle.
    const handle = await open(dir, "r");
    await expect(BoundedRangeSource.open(nodeRangeBackend(handle))).rejects.toMatchObject({ code: "unsupported" });
    expect(handle.fd).toBe(-1);
  }));
});
