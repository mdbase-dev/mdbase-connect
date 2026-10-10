import { describe, expect, it, vi } from "vitest";
import { connect, type Write } from "../src/client.js";
import type { Connector, FramePort } from "../src/transport/port.js";
import { clientFrame, receipt, submitResult, type Receipt, type RecordView } from "../src/wire.js";
import { MemoryReplica } from "../src/testing/index.js";

const mutation = "0192f3a4-6000-7abc-8def-0123456789ab";
const row = (path: string): RecordView => ({ id: mutation, path, revision: `sha256:${"11".repeat(32)}`, frontmatter: new Map(), types: [], state: { state: "confirmed", confirmedSeq: 1 } });
// Real MdbaseClient/Session frame routing with explicit receipt stand-ins. The
// memory model supplies only hello; no native/file publication authority proof.
async function fixture(initial: Receipt) {
  const hello = new MemoryReplica();
  const ports: FramePort[] = [];
  let response = initial, restored = initial;
  let early: Receipt[] = [];
  let awaits = 0;
  const connector: Connector = {
    description: "publication-tracking-stand-in",
    async open(request) {
      const base = await hello.connector().open(request);
      base.port.close();
      let closed = false;
      const port: FramePort = {
        onframe: null, onclose: null,
        send(raw) {
          const frame = clientFrame.dec(raw);
          if (frame.kind !== "request") throw new Error("Expected request frame.");
          const result = frame.method === "submit" ? submitResult.enc([response]) : frame.method === "await" ? (awaits++, receipt.enc(restored)) : null;
          queueMicrotask(() => {
            if (closed) return;
            if (frame.method === "submit") for (const r of early) port.onframe?.(clientFrame.enc({ kind: "push", type: "receipt", payload: receipt.enc(r) }));
            port.onframe?.(clientFrame.enc({ kind: "response", id: frame.id, result }));
          });
        },
        close() { if (!closed) { closed = true; port.onclose?.(); } },
      };
      ports.push(port);
      return { port, helloResponse: base.helloResponse };
    },
  };
  const client = await connect({ connector, app: { name: "tracking test", version: "0" }, timezone: "UTC", reconnect: { minDelayMs: 1, maxDelayMs: 1 } });
  return {
    client,
    submit: async () => (await client.submit([{ kind: "delete", id: mutation }], { mutationId: mutation }))[0]!,
    setResponse: (r: Receipt) => { response = r; },
    setRestored: (r: Receipt) => { restored = r; },
    setEarly: (...r: Receipt[]) => { early = r; },
    push: (r: Receipt) => ports.at(-1)!.onframe?.(clientFrame.enc({ kind: "push", type: "receipt", payload: receipt.enc(r) })),
    drop: () => ports.at(-1)!.close(),
    awaits: () => awaits,
  };
}
async function stillPublishing(write: Write) {
  let done = false;
  void write.published.then(() => { done = true; }, () => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
}

describe("client routes until BOTH receipt outcomes settle", () => {
  it.each(["published", "not_published"] as const)("keeps original pending write after confirmation until %s push", async published => {
    const f = await fixture({ mutation, state: "pending", published: "publishing" });
    try {
      const write = await f.submit();
      f.push({ mutation, state: "confirmed", seq: 7, published: "publishing" });
      await expect(write.confirmed).resolves.toMatchObject({ seq: 7 });
      await stillPublishing(write);
      f.push({ mutation, state: "confirmed", seq: 7, published });
      await expect(write.published).resolves.toMatchObject({ published });
    } finally { f.client.close(); }
  });
  it("tracks a confirmed/publishing submit response and reuses the original handle", async () => {
    const f = await fixture({ mutation, state: "confirmed", seq: 8, published: "publishing" });
    try {
      const write = await f.submit();
      await expect(write.confirmed).resolves.toMatchObject({ seq: 8 });
      expect(await f.submit()).toBe(write);
      await stillPublishing(write);
      f.push({ mutation, state: "confirmed", seq: 8, published: "published" });
      await expect(write.published).resolves.toMatchObject({ published: "published" });
    } finally { f.client.close(); }
  });
  it("keeps a locally published pending write until actual confirmation", async () => {
    const f = await fixture({ mutation, state: "pending", published: "published" });
    try {
      const write = await f.submit();
      await expect(write.published).resolves.toMatchObject({ state: "pending" });
      let confirmed = false; void write.confirmed.then(() => { confirmed = true; });
      await Promise.resolve(); expect(confirmed).toBe(false);
      f.push({ mutation, state: "confirmed", seq: 9 });
      await expect(write.confirmed).resolves.toMatchObject({ seq: 9 });
    } finally { f.client.close(); }
  });
  it.each(["pending", "confirmed"] as const)("consumes early %s publication push overtaking a confirmed/publishing submit response", async state => {
    const f = await fixture({ mutation, state: "confirmed", seq: 10, published: "publishing" });
    try {
      f.setEarly({ mutation, state, published: "published", ...(state === "confirmed" ? { seq: 10 } : {}) });
      const write = await f.submit();
      await expect(write.published).resolves.toMatchObject({ state: "confirmed", published: "published" });
      expect(write.state).toBe("confirmed");
    } finally { f.client.close(); }
  });
  it.each(["published", "not_published"] as const)("keeps early final %s across a later non-final push before submit returns", async published => {
    const f = await fixture({ mutation, state: "confirmed", seq: 10, published: "publishing" });
    try {
      f.setEarly({ mutation, state: "pending", published }, { mutation, state: "confirmed", seq: 10, published: "publishing" });
      const write = await f.submit();
      await expect(write.published).resolves.toMatchObject({ state: "confirmed", published });
    } finally { f.client.close(); }
  });
  it("reconciles early publishing before a confirmed response without the field can settle", async () => {
    const records = [row("original.md")];
    const f = await fixture({ mutation, state: "confirmed", seq: 14, relocatedFrom: 3, records });
    try {
      f.setEarly({ mutation, state: "pending", published: "publishing", records: [row("early.md")] });
      const write = await f.submit();
      await expect(write.confirmed).resolves.toMatchObject({ state: "confirmed", seq: 14, relocatedFrom: 3, records, published: "publishing" });
      await stillPublishing(write);
      f.push({ mutation, state: "confirmed", seq: 14, published: "not_published" });
      await expect(write.published).resolves.toMatchObject({ published: "not_published" });
    } finally { f.client.close(); }
  });
  it.each(["published", "not_published"] as const)("consumes known early %s before pub-omitted confirmation initialization", async published => {
    const f = await fixture({ mutation, state: "confirmed", seq: 15 });
    try {
      f.setEarly({ mutation, state: "pending", published });
      const write = await f.submit();
      await expect(write.published).resolves.toMatchObject({ state: "confirmed", seq: 15, published });
    } finally { f.client.close(); }
  });
  it.each(["rejected", "unknown"] as const)("initial %s still rejects publication despite buffered success", async state => {
    const f = await fixture({ mutation, state, problem: { code: state === "unknown" ? "outcome_unknown" : "conflict", recovery: "resolve_outcome", message: "fixture refusal" } });
    try {
      f.setEarly({ mutation, state: "pending", published: "published" });
      const write = await f.submit();
      await expect(write.published).rejects.toMatchObject({ code: state === "unknown" ? "outcome_unknown" : "conflict" });
    } finally { f.client.close(); }
  });
  it("still settles genuine no-files confirmation with no buffered publication", async () => {
    const f = await fixture({ mutation, state: "confirmed", seq: 16 });
    try { await expect((await f.submit()).published).resolves.toMatchObject({ state: "confirmed", seq: 16 }); }
    finally { f.client.close(); }
  });
  it("restores confirmation without dropping publication, including repeated reconnect and omitted field", async () => {
    const f = await fixture({ mutation, state: "pending", published: "publishing" });
    try {
      const write = await f.submit();
      f.setRestored({ mutation, state: "confirmed", seq: 11, published: "publishing" });
      f.drop();
      await vi.waitFor(() => expect(write.state).toBe("confirmed"));
      await stillPublishing(write);
      f.setRestored({ mutation, state: "confirmed", seq: 11 });
      f.drop();
      await vi.waitFor(() => expect(f.awaits()).toBe(2));
      await stillPublishing(write);
      f.push({ mutation, state: "confirmed", seq: 11, published: "not_published" });
      await expect(write.published).resolves.toMatchObject({ published: "not_published" });
    } finally { f.client.close(); }
  });
  it.each(["rejected", "unknown"] as const)("routes %s to the still-unsettled publication promise", async state => {
    const f = await fixture({ mutation, state: "confirmed", seq: 12, published: "publishing" });
    try {
      const write = await f.submit();
      f.push({ mutation, state, problem: { code: state === "unknown" ? "outcome_unknown" : "conflict", recovery: "resolve_outcome", message: "fixture refusal" } });
      await expect(write.published).rejects.toMatchObject({ code: state === "unknown" ? "outcome_unknown" : "conflict" });
    } finally { f.client.close(); }
  });
});
