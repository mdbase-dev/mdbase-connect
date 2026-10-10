import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { HostDriver, HostLoop, type HostDone, type HostOp, type QueuedCore } from "../src/host/driver.js";
import { remoteHostOps, serveHostOps, type PortLike } from "../src/host/bridge.js";
import { DualJournal } from "../src/journal/dual.js";
import { IdbJournalCopy } from "../src/journal/idbCopy.js";
import { VaultJournalCopy, adapterFileIO } from "../src/journal/vaultCopy.js";
import { VaultPlatform } from "../src/vault/platform.js";
import { ObsidianEditorFence, type MarkdownViewLike } from "../src/fence/editorFence.js";
import { FakeVault } from "./fakeVault.js";

const desktop = { isMobileApp: false, isAndroidApp: false, isIosApp: false };
const enc = new TextEncoder();

async function setup(views: MarkdownViewLike[] = []) {
  const fv = new FakeVault();
  fv.dirs.add("Tasks");
  const app = fv.app;
  const vault = new VaultPlatform(app, { root: "Tasks", platform: desktop });
  const idb = await IdbJournalCopy.open("c/d", new IDBFactory());
  const journal = new DualJournal([idb, new VaultJournalCopy(adapterFileIO(app.vault.adapter as never), "Tasks/.mdbase/devices/d", "c/d")]);
  const ws = { getLeavesOfType: () => views.map((view) => ({ view })), on: () => ({}), offref: () => {} };
  const fence = new ObsidianEditorFence(ws, "1.13.8");
  return { fv, driver: new HostDriver(vault, journal, fence), idb };
}

describe("HostDriver", () => {
  it("routes file, journal and fence ops", async () => {
    const editor = { buf: "a\n", getValue() { return this.buf; }, offsetToPos: (o: number) => ({ line: 0, ch: o }), transaction() {} };
    const { fv, driver, idb } = await setup([{ file: { path: "Tasks/open.md" }, editor, dirty: false, saving: false, lastSavedData: "a\n" } as MarkdownViewLike]);
    fv.setText("Tasks/a.md", "x");
    const f = await driver.perform({ kind: "File", op: { op: "GuardedReplace", path: "a.md", expect: enc.encode("x"), new: enc.encode("y") } });
    expect(f).toMatchObject({ kind: "File", result: { ok: true, value: { kind: "Guarded", value: { kind: "Done" } } } });
    expect(fv.text("Tasks/a.md")).toBe("y");
    expect(await driver.perform({ kind: "File", op: { op: "OtherHolders", path: "a.md" } })).toMatchObject({ result: { ok: true, value: { kind: "Holders", value: "Unknown" } } });
    expect(await driver.perform({ kind: "Journal", op: { op: "Load" } })).toEqual({ kind: "JournalLoad", result: { ok: true, entries: [] } });
    expect(await driver.perform({ kind: "Journal", op: { op: "Append", batch: [{ space: 1, key: enc.encode("k"), version: 1, value: enc.encode("v") }] } })).toEqual({ kind: "JournalUnit", result: { ok: true } });
    expect(await driver.perform({ kind: "Journal", op: { op: "Append", batch: [{ space: 1, key: enc.encode("k"), version: 1, value: null }] } })).toMatchObject({ kind: "JournalUnit", result: { ok: false, error: { kind: "other" } } });
    expect(await driver.perform({ kind: "Fence", op: { op: "State", path: "open.md" } })).toEqual({ kind: "FenceState", state: { kind: "Open", dirty: false } });
    expect(await driver.perform({ kind: "Fence", op: { op: "State", path: "closed.md" } })).toEqual({ kind: "FenceState", state: { kind: "Closed" } });
    idb.close();
  });
});

describe("HostLoop", () => {
  it("drains, performs out of order, completes and re-polls until quiet", async () => {
    const queue: [bigint, HostOp][] = [];
    const completed: bigint[] = [];
    let polls = 0;
    let next = 1n;
    const core: QueuedCore = {
      takeRequests: () => queue.splice(0),
      complete: (id) => completed.push(id),
      poll: () => {
        polls++;
        // The store issues a follow-up op after the first completes.
        if (polls === 1) for (let i = 0; i < 3; i++) queue.push([next++, { kind: "Fence", op: { op: "State", path: `p${i}` } }]);
        if (completed.length === 3 && polls < 10 && !queue.length && next === 4n) queue.push([next++, { kind: "Journal", op: { op: "Load" } }]);
        return null;
      },
    };
    const delays = [30, 5, 15, 1];
    const loop = new HostLoop(core, (op) => new Promise<HostDone>((r) => setTimeout(() => r({ kind: "FenceState", state: { kind: "Closed" } }), delays.shift() ?? 1)));
    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    await loop.stop();
    expect(completed.sort()).toEqual([1n, 2n, 3n, 4n]);
  });
});

describe("Worker bridge", () => {
  it("carries ops and results, rebuilding FsError", async () => {
    const { port1, port2 } = new MessageChannel();
    const wrap = (p: MessagePort): PortLike => {
      p.start();
      return p as unknown as PortLike;
    };
    const { fv, driver, idb } = await setup();
    const stop = serveHostOps(wrap(port1), (op) => driver.perform(op));
    const remote = remoteHostOps(wrap(port2));
    fv.setText("Tasks/a.md", "x");
    const ok = await remote.perform({ kind: "File", op: { op: "Read", path: "a.md" } });
    expect(ok.kind === "File" && ok.result.ok && ok.result.value.kind === "Read" && new TextDecoder().decode(ok.result.value.value.bytes)).toBe("x");
    const err = await remote.perform({ kind: "File", op: { op: "Read", path: "missing.md" } });
    expect(err.kind === "File" && !err.result.ok && err.result.error.kind).toBe("NotFound");
    expect(err.kind === "File" && !err.result.ok && err.result.error.name).toBe("FsError");
    stop();
    remote.close();
    port1.close();
    port2.close();
    idb.close();
  });
});

import { SecretsSlot, transferSecrets } from "../src/host/secrets.js";
import { checkRelPath } from "../src/vault/types.js";

describe("device secrets handover", () => {
  it("transfers the buffer and leaves nothing readable behind", async () => {
    const { port1, port2 } = new MessageChannel();
    const got = new Promise<Uint8Array>((r) => {
      port2.onmessage = (ev) => r(ev.data.secrets);
    });
    const secrets = new Uint8Array(96).fill(7);
    transferSecrets(port1 as unknown as { postMessage(m: unknown, t: Transferable[]): void }, "c", secrets);
    expect(secrets.byteLength === 0 || secrets.every((b) => b === 0)).toBe(true);
    const received = await got;
    expect(received.length).toBe(96);
    const slot = new SecretsSlot();
    expect(slot.receive({ t: "mdbase-secrets", secrets: received })).toBe(true);
    expect(JSON.stringify({ slot })).not.toContain("7");
    expect(slot.take((s) => s[0])).toBe(7);
    expect(received.every((b) => b === 0)).toBe(true);
    expect(() => slot.take(() => 0)).toThrow();
    port1.close();
    port2.close();
  });
  it("a view onto a larger buffer is copied, sent and both zeroed", () => {
    const big = new Uint8Array(200).fill(9);
    const view = big.subarray(10, 106);
    const sent: unknown[] = [];
    transferSecrets({ postMessage: (m) => sent.push(m) }, "c", view);
    expect(view.every((b) => b === 0)).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("checkRelPath second line of defence", () => {
  it("rejects ':' and control characters", () => {
    for (const bad of ["a:b.md", "C:/x.md", "n/a.md:stream", "a\u0001.md", "a\nb.md", "a\u007f"]) expect(() => checkRelPath(bad)).toThrow();
    for (const ok of ["a.md", "notes/ünïcode.md", "a b/c-d.md"]) expect(() => checkRelPath(ok)).not.toThrow();
  });
});
