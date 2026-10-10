import { describe, expect, it } from "vitest";
import { connect, isMdbaseError, LiveQuery, MdbaseClient } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { toPlain } from "../src/values.js";

const app = { name: "test", version: "0.0.0" };

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function setup(opts: ConstructorParameters<typeof MemoryReplica>[0] = {}) {
  const replica = new MemoryReplica({ confirmDelayMs: null, ...opts });
  return {
    replica,
    client: () =>
      connect({ connector: replica.connector(), app, timezone: "UTC", reconnect: { minDelayMs: 5, maxDelayMs: 20 } }),
  };
}

describe("session", () => {
  it("says hello and exposes grant and status", async () => {
    const { replica, client } = setup();
    const c = await client();
    expect(c.collection).toBe(replica.collection);
    expect(c.hello.grant.role).toBe("owner");
    expect(c.status.confirmedThrough).toBe(0);
    c.close();
  });

  it("surfaces a refused hello as the problem's code", async () => {
    const { client } = setup({ refuse: { code: "forbidden", recovery: "reauthorize", message: "grant revoked" } });
    await expect(client()).rejects.toMatchObject({ code: "forbidden", recovery: "reauthorize" });
  });
});

describe("writes", () => {
  it("create returns an optimistic pending receipt, then confirms", async () => {
    const { replica, client } = setup();
    const c = await client();
    const w = await c.create({ type: "task", path: "t/a.md", frontmatter: { status: "open" }, body: "hi" });
    expect(w.state).toBe("pending");
    expect(w.records[0]!.state.state).toBe("pending");
    expect(toPlain(w.records[0]!.frontmatter.get("status")!)).toBe("open");
    expect(c.status.pending).toBe(0); // status is pushed only to subscribers
    replica.confirmAll();
    const r = await w.confirmed;
    expect(r.state).toBe("confirmed");
    expect(r.seq).toBe(1);
    c.close();
  });

  it("rejection rejects `confirmed` with the 15-code problem", async () => {
    const { replica, client } = setup();
    const c = await client();
    const w = await c.create({ path: "x.md" });
    replica.reject(w.mutationId);
    expect(replica.allRecords).toHaveLength(0); // the optimistic create is rolled back
    await expect(w.confirmed).rejects.toMatchObject({ code: "conflict", reason: "revision", recovery: "resolve_conflict" });
    c.close();
  });

  it("update from a RecordView sends base and body edits", async () => {
    const { replica, client } = setup();
    const rec = replica.seed({ path: "n.md", frontmatter: { status: "open", n: 1 }, body: "hello world" });
    const c = await client();
    const seen = await c.get(rec.id, { body: true });
    const op = c.updateOp(seen, { patch: { status: "done", n: 1 }, body: "hello brave world" });
    expect(op.base).toEqual([{ key: "status", observed: "open" }]);
    expect([...op.patch!.keys()]).toEqual(["status"]); // unchanged n dropped
    expect(op.bodyEdits).toEqual([[6, 6, "brave "]]);
    const w = await c.update(seen, { patch: { status: "done" }, body: "hello brave world" });
    expect(w.records[0]!.state.state).toBe("pending");
    const after = await c.get(rec.id, { body: true });
    expect(after.body).toBe("hello brave world");
    c.close();
  });

  it("resubmitting a mutation ID is idempotent", async () => {
    const { replica, client } = setup();
    const c = await client();
    const id = "0192f3a4-6000-7abc-8def-0123456789ab";
    await c.create({ path: "a.md" }, { mutationId: id });
    await c.create({ path: "a.md" }, { mutationId: id });
    expect(replica.allRecords).toHaveLength(1);
    c.close();
  });

  it("CAS conflict comes back as `conflict` / `revision`", async () => {
    const { replica, client } = setup();
    const rec = replica.seed({ path: "a.md" });
    const c = await client();
    const [w] = await c.submit([{ kind: "update", id: rec.id, ifRevision: `sha256:${"0".repeat(64)}`, body: "x" }]);
    expect(w!.state).toBe("rejected");
    expect(w!.receipt.problem?.code).toBe("conflict");
    c.close();
  });
});

describe("live queries", () => {
  it("pushes a snapshot, then diffs for creates, updates and deletes", async () => {
    const { replica, client } = setup();
    replica.seed({ path: "b.md", types: ["task"], frontmatter: { rank: 2 } });
    const c = await client();
    const live: LiveQuery = c.live({ types: ["task"], order_by: ["rank"] });
    await live.ready;
    expect(live.stale).toBe(false);
    expect(live.records.map((r) => r.path)).toEqual(["b.md"]);

    const w = await c.create({ type: "task", path: "a.md", frontmatter: { rank: 1 } });
    await until(() => live.records.length === 2);
    expect(live.records.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    expect(live.get(w.records[0]!.id)!.state.state).toBe("pending");

    replica.confirmAll();
    await until(() => live.get(w.records[0]!.id)!.state.state === "confirmed");

    await c.delete(w.records[0]!);
    await until(() => live.records.length === 1);
    live.close();
    c.close();
  });

  it("windowed queries return only the window, and widen on setQuery", async () => {
    const { replica, client } = setup();
    for (let i = 0; i < 10; i++) replica.seed({ path: `n${i}.md`, types: ["note"], body: "x".repeat(1000) });
    const c = await client();
    const live = c.live({ types: ["note"], limit: 3 });
    await live.ready;
    expect(live.records).toHaveLength(3);
    expect(live.records[0]!.body).toBeUndefined(); // no bodies unless asked
    await live.setQuery({ types: ["note"], limit: 6 });
    await until(() => live.records.length === 6 && !live.stale);
    c.close();
  });

  it("survives a dropped link: reconnects, re-subscribes and catches up", async () => {
    const { replica, client } = setup();
    const c = await client();
    const live = c.live({ types: ["task"] });
    await live.ready;
    const links: string[] = [];
    c.onLink((s) => links.push(s));
    replica.dropConnections();
    replica.seed({ path: "while-away.md", types: ["task"] });
    await until(() => c.link === "open" && live.records.length === 1 && !live.stale);
    expect(links).toEqual(["reconnecting", "open"]);
    c.close();
  });
});

describe("receipts across reconnects", () => {
  it("a pending write still confirms after the link drops", async () => {
    const { replica, client } = setup();
    const c = await client();
    const w = await c.create({ path: "a.md" });
    replica.dropConnections();
    await until(() => replica.sessionCount === 0);
    await until(() => c.link === "open" && replica.sessionCount === 1);
    replica.confirmAll();
    await expect(w.confirmed).resolves.toMatchObject({ state: "confirmed" });
    c.close();
  });
});

describe("status", () => {
  it("pushes confirmed-through and pending counts", async () => {
    const { replica, client } = setup();
    const c = await client();
    const seen: [number, number][] = [];
    c.onStatus((s) => seen.push([s.confirmedThrough, s.pending]));
    await new Promise((r) => setTimeout(r, 10));
    replica.setOnline(false);
    await c.create({ path: "a.md" });
    await until(() => c.status.pending === 1 && c.status.connection === "offline");
    replica.setOnline(true);
    replica.confirmAll();
    await until(() => c.status.pending === 0 && c.status.confirmedThrough === 1);
    c.close();
  });
});

describe("errors", () => {
  it("not_found for a missing record; find() returns null", async () => {
    const { client } = setup();
    const c: MdbaseClient = await client();
    await expect(c.get({ path: "nope.md" })).rejects.toSatisfy((e) => isMdbaseError(e, "not_found"));
    await expect(c.find({ path: "nope.md" })).resolves.toBeNull();
    c.close();
  });

  it("an aborted request is `cancelled`", async () => {
    const { client } = setup();
    const c = await client();
    const ac = new AbortController();
    ac.abort();
    await expect(c.get({ path: "a.md" }, undefined, ac.signal)).rejects.toMatchObject({ code: "cancelled" });
    c.close();
  });
});

describe("files", () => {
  it("uploads with a digest commitment and downloads the same bytes", async () => {
    const { replica, client } = setup();
    const c = await client();
    const data = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
    const phases: string[] = [];
    const w = await c.files.upload("img/a.png", data, { onProgress: (p) => phases.push(p.phase) });
    expect(w.state).toBe("pending");
    expect(phases).toContain("receiving");
    replica.confirmAll();
    await w.confirmed;
    const files = [];
    for await (const f of c.files.list({ folder: "img" })) files.push(f);
    expect(files.map((f) => [f.path, f.media, f.size])).toEqual([["img/a.png", "image", data.length]]);
    const back = await c.files.download(files[0]!);
    expect(Buffer.compare(back, data)).toBe(0);
    c.close();
  });

  it("moves and deletes through submit", async () => {
    const { replica, client } = setup();
    const c = await client();
    await c.files.upload("a.pdf", new Uint8Array([1, 2, 3]));
    replica.confirmAll();
    const f = await c.files.get({ path: "a.pdf" });
    await c.files.move(f, "docs/a.pdf");
    expect((await c.files.get(f.id)).path).toBe("docs/a.pdf");
    await c.files.delete(f.id);
    await expect(c.files.get(f.id)).rejects.toMatchObject({ code: "not_found" });
    c.close();
  });
});

describe("presence", () => {
  it("peers see each other's state", async () => {
    const { replica, client } = setup();
    const rec = replica.seed({ path: "a.md" });
    const a = await client();
    const b = await client();
    let peers: unknown[] = [];
    b.presence.subscribe(rec.id, (p) => (peers = p.map((x) => toPlain(x.state))));
    await a.presence.join(rec.id, { cursor: 3 });
    await until(() => peers.length === 1);
    expect(peers).toEqual([{ cursor: 3 }]);
    a.presence.update(rec.id, { cursor: 9 });
    await until(() => JSON.stringify(peers) === JSON.stringify([{ cursor: 9 }]));
    await a.presence.leave(rec.id);
    await until(() => peers.length === 0);
    a.close();
    b.close();
  });
});

describe("change feed", () => {
  it("watchChanges delivers pushes", async () => {
    const { client } = setup();
    const c = await client();
    const paths: string[] = [];
    c.watchChanges(undefined, (b) => paths.push(...b.changes.map((x) => x.path)));
    await new Promise((r) => setTimeout(r, 10));
    await c.create({ path: "a.md" });
    await until(() => paths.includes("a.md"));
    c.close();
  });
});

import { encode, toHex } from "../src/cbor.js";
import { rememberWitness, witnessesFor, _clearWitnesses } from "../src/witness.js";
describe("head witnesses", () => {
  const w = (dev: number, seq: number) =>
    encode(new Map<number, import("../src/cbor.js").CborValue>([[0, 1], [1, new Uint8Array(16)], [2, new Uint8Array(16).fill(dev)], [3, seq]]));
  const dev = (n: number) => toHex(new Uint8Array(16).fill(n));
  it("keeps the newest per device and excludes the replica's own device", () => {
    _clearWitnesses();
    rememberWitness("c", w(1, 5), dev(1));
    rememberWitness("c", w(1, 3), dev(1));
    rememberWitness("c", w(2, 9), dev(2));
    expect(witnessesFor("c")).toHaveLength(2);
    const toDev2 = witnessesFor("c", w(2, 10));
    expect(toDev2).toEqual([w(1, 5)]);
    rememberWitness("c", new Uint8Array([0xff]));
    expect(witnessesFor("c")).toHaveLength(2);
  });

  it("a remote replica can only vouch for its own device", () => {
    _clearWitnesses();
    rememberWitness("c", w(1, 5), dev(1)); // genuine, from device 1 itself
    // A malicious replica (device 9) claims device 1 and many fake devices.
    for (let i = 0; i < 100; i++) rememberWitness("c", w(i % 50 + 10, 1000 + i), dev(9));
    rememberWitness("c", w(1, 1000), dev(9));
    expect(witnessesFor("c")).toEqual([w(1, 5)]);
    // Its own witness is accepted.
    rememberWitness("c", w(9, 7), dev(9));
    expect(witnessesFor("c")).toHaveLength(2);
  });

  it("sessions with an unknown device vouch for nothing (fail closed)", () => {
    _clearWitnesses();
    rememberWitness("c", w(3, 5));
    rememberWitness("c", w(3, 5), undefined);
    expect(witnessesFor("c")).toEqual([]);
  });;
});

import { summarizeStatus } from "../src/status.js";
import { receipt as receiptCodec } from "../src/wire.js";
import { decode as cborDecode, encode as cborEncode } from "../src/cbor.js";
describe("local-only collection behavior", () => {
  it("a confirmed receipt without seq decodes and settles `confirmed`", async () => {
    const r = receiptCodec.dec(cborDecode(cborEncode(receiptCodec.enc({ mutation: "0192f3a4-6000-7abc-8def-0123456789ab", state: "confirmed", status: "applied" }))));
    expect(r.seq).toBeUndefined();
    const { Write } = await import("../src/client.js");
    const w = new Write({ ...r, state: "pending" });
    w.update(r);
    await expect(w.confirmed).resolves.toMatchObject({ state: "confirmed" });
  });
  it("status: saved on this device, never 'synced through 0'", () => {
    const s = summarizeStatus({ mode: "local_only", confirmedThrough: 0, headKnown: 0, pending: 0, holds: 0, unresolved: 0, connection: "offline", incidents: [] });
    expect(s).toMatchObject({ kind: "local", text: "Saved on this device", confirmedThrough: null });
    expect(summarizeStatus({ mode: "synced", confirmedThrough: 5, headKnown: 9, pending: 2, holds: 0, unresolved: 0, connection: "online", incidents: [] }).kind).toBe("catching_up");
  });
});
