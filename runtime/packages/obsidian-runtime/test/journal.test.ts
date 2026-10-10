import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { DualJournal, unionCopies } from "../src/journal/dual.js";
import { IdbJournalCopy } from "../src/journal/idbCopy.js";
import { VaultJournalCopy, type VaultFileIO } from "../src/journal/vaultCopy.js";
import { decodeBatch, encodeBatch, JournalError, type JournalEntry } from "../src/journal/types.js";

class MemVault implements VaultFileIO {
  files = new Map<string, string>();
  failWrite: ((path: string, data: string) => string | null) | null = null;
  async read(p: string) {
    return this.files.get(p) ?? null;
  }
  async write(p: string, d: string) {
    if (this.failWrite) {
      const partial = this.failWrite(p, d);
      if (partial !== null) {
        this.files.set(p, partial);
        throw new Error("torn write");
      }
    }
    this.files.set(p, d);
  }
  async append(p: string, d: string) {
    if (!this.files.has(p)) throw new Error("ENOENT");
    this.files.set(p, this.files.get(p)! + d);
  }
  async mkdirs() {}
}

const NS = "col-1/dev-1";
const DIR = ".mdbase/devices/dev-1";
const k = (s: string) => new TextEncoder().encode(s);
const v = (s: string) => new TextEncoder().encode(s);
const set = (key: string, version: number, value: string): JournalEntry => ({ space: 1, key: k(key), version, value: v(value) });
const del = (key: string, version: number): JournalEntry => ({ space: 1, key: k(key), version, value: null });
const view = (es: JournalEntry[]) => Object.fromEntries(es.map((e) => [new TextDecoder().decode(e.key), new TextDecoder().decode(e.value!)]));

let n = 0;
async function open(vault: MemVault, idb: IDBFactory, ns = NS) {
  const idbCopy = await IdbJournalCopy.open(ns, idb);
  const vaultCopy = new VaultJournalCopy(vault, DIR, ns);
  const j = new DualJournal([idbCopy, vaultCopy]);
  return { j, idbCopy, vaultCopy, close: () => idbCopy.close() };
}
const freshIdb = () => new IDBFactory();
const wipe = async (idb: IDBFactory) => {
  const dbs = await idb.databases();
  for (const d of dbs) await new Promise((r) => { const q = idb.deleteDatabase(d.name!); q.onsuccess = q.onerror = () => r(null); });
};

describe("batch encoding", () => {
  it("round-trips", () => {
    const b = [set("a", 1, "x"), del("b", 2), { space: 255, key: new Uint8Array(0), version: 2 ** 52, value: new Uint8Array(0) }];
    expect(decodeBatch(encodeBatch(b))).toEqual(b);
    expect(() => decodeBatch(encodeBatch(b).slice(0, -1))).toThrow();
  });
});

describe("DualJournal", () => {
  it("appends to both and loads the live set", async () => {
    const vault = new MemVault();
    const idb = freshIdb();
    let s = await open(vault, idb);
    expect(await s.j.load()).toEqual([]);
    await s.j.append([set("a", 1, "1"), set("b", 2, "2")]);
    await s.j.append([del("a", 3), set("c", 4, "4")]);
    s.close();
    s = await open(vault, idb);
    expect(view(await s.j.load())).toEqual({ b: "2", c: "4" });
    expect(s.j.lastReport!.repaired).toBe(false);
    expect(s.j.lastReport!.copies.map((c) => c.state)).toEqual(["ok", "ok"]);
    s.close();
  });

  it("recovers from the vault file after Clear storage, and repairs IndexedDB", async () => {
    const vault = new MemVault();
    const idb = freshIdb();
    let s = await open(vault, idb);
    await s.j.load();
    await s.j.append([set("a", 1, "1")]);
    s.close();
    await wipe(idb);
    s = await open(vault, idb);
    expect(view(await s.j.load())).toEqual({ a: "1" });
    expect(s.j.lastReport!.repaired).toBe(true);
    expect((await s.idbCopy.load()).entries.length).toBe(1);
    s.close();
  });

  it("recovers the tail from IndexedDB after power loss tore the vault file", async () => {
    const vault = new MemVault();
    const idb = freshIdb();
    let s = await open(vault, idb);
    await s.j.load();
    for (let i = 1; i <= 10; i++) await s.j.append([set(`k${i}`, i, `v${i}`)]);
    s.close();
    const [path, text] = [...vault.files.entries()][0]!;
    vault.files.set(path, text.slice(0, text.length - 37)); // tail lost mid-line
    s = await open(vault, idb);
    expect(Object.keys(view(await s.j.load())).length).toBe(10);
    s.close();
  });

  it("does not resurrect a compacted delete when one copy failed to compact", async () => {
    const vault = new MemVault();
    const idb = freshIdb();
    let s = await open(vault, idb);
    await s.j.load();
    await s.j.append([set("gone", 1, "x"), set("kept", 2, "y")]);
    await s.j.append([del("gone", 3)]);
    vault.failWrite = (_p, d) => d.slice(0, 10); // the vault compaction tears
    await expect(s.j.compact([set("kept", 2, "y")])).rejects.toThrow();
    vault.failWrite = null;
    s.close();
    // Make the vault copy hold the pre-delete state only (as if its tail was lost too).
    const live = [...vault.files.entries()].find(([, t]) => t.includes("\nC:"))!;
    const lines = live[1].split("\n");
    vault.files.set(live[0], lines.slice(0, lines.length - 2).join("\n") + "\n");
    s = await open(vault, idb);
    expect(view(await s.j.load())).toEqual({ kept: "y" });
    s.close();
  });

  it("a torn A/B compaction leaves the previous file in charge", async () => {
    const vault = new MemVault();
    const idb = freshIdb();
    let s = await open(vault, idb);
    await s.j.load();
    await s.j.append([set("a", 1, "1")]);
    await s.j.compact([set("a", 1, "1")]); // now on B
    await s.j.append([set("b", 2, "2")]);
    vault.failWrite = (_p, d) => d.slice(0, d.length - 5); // compaction into A tears before C
    await expect(s.j.compact([set("a", 1, "1"), set("b", 2, "2")])).rejects.toThrow();
    vault.failWrite = null;
    s.close();
    await wipe(idb);
    s = await open(vault, idb);
    expect(view(await s.j.load())).toEqual({ a: "1", b: "2" });
    s.close();
  });

  it("ignores journal files of another device or collection (copied in by a sync tool)", async () => {
    const vault = new MemVault();
    let s = await open(vault, freshIdb(), "other/dev");
    await s.j.load();
    await s.j.append([set("x", 1, "1")]);
    s.close();
    s = await open(vault, freshIdb());
    expect(await s.j.load()).toEqual([]); // not ours: ignored
    s.close();
  });

  it("reports lost when every copy is unreadable", async () => {
    const vault = new MemVault();
    vault.files.set(`${DIR}/journal-a.log`, "garbage\n");
    const s = await open(vault, freshIdb());
    await expect(s.j.load()).rejects.toMatchObject({ kind: "lost" });
    s.close();
  });

  it("refuses versions that do not increase", async () => {
    const s = await open(new MemVault(), freshIdb());
    await s.j.load();
    await s.j.append([set("a", 5, "1")]);
    await expect(s.j.append([set("b", 5, "2")])).rejects.toThrow(/not above/);
    s.close();
  });

  it("randomised crashes: every acknowledged write survives losing either copy", async () => {
    let seed = 12345;
    const rnd = (m: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % m;
    };
    for (let trial = 0; trial < 40; trial++) {
      const vault = new MemVault();
      const idb = freshIdb();
      const model = new Map<string, string>();
      let version = 0;
      let s = await open(vault, idb);
      await s.j.load();
      for (let round = 0; round < 3; round++) {
        const ops = 1 + rnd(15);
        for (let i = 0; i < ops; i++) {
          const key = `k${rnd(6)}`;
          version++;
          if (rnd(4) === 0) {
            await s.j.append([del(key, version)]);
            model.delete(key);
          } else {
            await s.j.append([set(key, version, `v${version}`)]);
            model.set(key, `v${version}`);
          }
          if (rnd(10) === 0) {
            await s.j.compact([...model].map(([kk, vv]) => set(kk, Number(vv.slice(1)), vv)));
          }
        }
        s.close();
        // Crash: lose IndexedDB entirely, or lose a random tail of the live vault file.
        if (rnd(2) === 0) await wipe(idb);
        else {
          for (const [p, t] of vault.files) if (rnd(2) === 0) vault.files.set(p, t.slice(0, t.length - rnd(Math.min(t.length, 200))));
        }
        s = await open(vault, idb);
        const got = view(await s.j.load());
        expect(got).toEqual(Object.fromEntries(model));
      }
      s.close();
    }
  });
});

describe("unionCopies", () => {
  it("highest version wins, floors drop compacted deletes", () => {
    const u = unionCopies([
      { state: "ok", entries: [set("a", 1, "old"), set("z", 2, "zombie")], floor: 0, damaged: 0 },
      { state: "ok", entries: [set("a", 4, "new")], floor: 3, damaged: 0 },
    ]);
    expect([...u.keys()].length).toBe(1);
    expect(new TextDecoder().decode([...u.values()][0]!.value!)).toBe("new");
  });
});

describe("vault copy edge cases (from the desktop e2e)", () => {
  it("a torn very first snapshot means never written, not lost", async () => {
    const vault = new MemVault();
    vault.files.set(`${DIR}/journal-a.log`, (await (async () => {
      const v2 = new MemVault();
      const c = new VaultJournalCopy(v2, DIR, NS);
      await c.compact([], 0);
      return [...v2.files.values()][0]!;
    })()).split("\n")[0] + "\n"); // header only: torn before C
    const s = await open(vault, freshIdb());
    expect(await s.j.load()).toEqual([]);
    s.close();
  });
  it("another namespace's files are ignored, not corrupt", async () => {
    const vault = new MemVault();
    let s = await open(vault, freshIdb(), "other/ns");
    await s.j.load();
    await s.j.append([set("x", 1, "1")]);
    s.close();
    s = await open(vault, freshIdb());
    expect(await s.j.load()).toEqual([]);
    await s.j.append([set("y", 1, "2")]);
    s.close();
    s = await open(vault, freshIdb());
    expect(view(await s.j.load())).toEqual({ y: "2" });
    s.close();
  });
});
