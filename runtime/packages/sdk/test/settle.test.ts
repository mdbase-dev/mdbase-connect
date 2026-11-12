// settle(): one answer for every way a write can end, over MemoryReplica and,
// for receipts the test replica does not produce, over a stub client.
import { afterEach, describe, expect, it } from "vitest";
import { connect, mdbaseError, uuidv7, Write, type MdbaseClient, type Receipt, type RecordView } from "../src/index.js";
import { settleWrite } from "../src/settle.js";
import { MemoryReplica, type MemoryReplicaOptions } from "../src/testing/index.js";

const clients: MdbaseClient[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.close(); });
async function open(replica: MemoryReplica) {
  const client = await connect({ connector: replica.connector(), app: { name: "settle-test", version: "test" }, reconnect: false });
  clients.push(client);
  return client;
}
const replicaWith = (o: MemoryReplicaOptions = {}) => new MemoryReplica({ confirmDelayMs: 0, ...o });

describe("settle over a replica", () => {
  it("confirms a create and reads the record back", async () => {
    const client = await open(replicaWith());
    const saved = await client.settle(client.create({ path: "notes/a.md", body: "a" }), { read: { include: { body: true } } });
    expect(saved).toMatchObject({ outcome: "confirmed", receipt: { state: "confirmed" }, record: { path: "notes/a.md", body: "a" } });
    expect(saved.mutationId).toBe(saved.outcome === "confirmed" ? saved.receipt.mutation : undefined);
  });

  it("reads back the record an update, rename or replace targets without being told which", async () => {
    const replica = replicaWith(), client = await open(replica);
    const seeded = replica.seed({ path: "notes/a.md", frontmatter: { title: "old" }, body: "a" });
    const record = await client.get(seeded.id, { include: { body: true, document: true } });
    const updated = await client.settle(client.update(record, { patch: { title: "new" } }), { read: true });
    expect(updated).toMatchObject({ outcome: "confirmed", record: { id: seeded.id } });
    const current = await client.get(seeded.id);
    const moved = await client.settle(client.rename(current, "notes/b.md"), { read: true });
    expect(moved).toMatchObject({ outcome: "confirmed", record: { id: seeded.id, path: "notes/b.md" } });
  });

  it("reports a deleted record as null, not as a failed read", async () => {
    const replica = replicaWith(), client = await open(replica);
    const seeded = replica.seed({ path: "notes/a.md" });
    const gone = await client.settle(client.delete(seeded.id), { read: true });
    expect(gone).toMatchObject({ outcome: "confirmed", record: null });
  });

  it("says saved_on_device when the wait ends first, and confirms the same mutation later", async () => {
    const replica = replicaWith({ confirmDelayMs: null }), client = await open(replica);
    const kept = await client.settle(client.create({ path: "notes/slow.md", body: "a" }), { timeoutMs: 20, read: true });
    expect(kept).toMatchObject({ outcome: "saved_on_device", receipt: { state: "pending" }, record: { path: "notes/slow.md" } });
    replica.confirmAll();
    expect(await client.settle(kept.mutationId!)).toMatchObject({ outcome: "confirmed", mutationId: kept.mutationId });
    expect(replica.allRecords).toHaveLength(1);
  });

  it("reports a write the log rejects, with its receipt and problem", async () => {
    const replica = replicaWith({ confirmDelayMs: null }), client = await open(replica);
    const write = await client.create({ path: "notes/refused.md", body: "x" });
    const settling = client.settle(write, { timeoutMs: 2_000, read: true });
    replica.reject(write.mutationId);
    expect(await settling).toMatchObject({
      outcome: "rejected", mutationId: write.mutationId, receipt: { state: "rejected" }, problem: { code: "conflict", reason: "revision" },
    });
  });

  it("reports a write the replica refused to take as rejected with no receipt", async () => {
    const replica = replicaWith(), client = await open(replica);
    replica.failNextWrite();
    const refused = await client.settle(client.create({ path: "notes/a.md", body: "a" }), { read: true });
    expect(refused).toMatchObject({ outcome: "rejected", problem: { code: "unavailable", reason: "storage_busy" } });
    expect(refused.mutationId).toBeTypeOf("string");
    expect("receipt" in refused).toBe(false);
    expect(replica.allRecords).toHaveLength(0);
  });

  it("reports a write refused before it was sent as rejected with no mutation", async () => {
    const client = await open(replicaWith({ role: "viewer" }));
    const refused = await client.settle(client.create({ path: "notes/a.md", body: "a" }));
    expect(refused).toMatchObject({ outcome: "rejected", problem: { code: "forbidden", reason: "read_only" } });
    expect(refused.mutationId).toBeUndefined();
  });

  it("keeps a write whose reply was lost as unknown, then settles that mutation on a new connection", async () => {
    const replica = replicaWith(), client = await open(replica);
    // The ledger's first read must not be the request whose reply is lost.
    await client.settle(client.create({ path: "notes/first.md", body: "a" }));
    replica.loseNextResponse();
    const lost = await client.settle(client.create({ path: "notes/lost.md", body: "a" }), { read: true });
    expect(lost).toMatchObject({ outcome: "unknown", problem: { code: "outcome_unknown", reason: "receipt_unavailable" } });
    const again = await open(replica);
    const found = await again.settle(lost.mutationId!, { read: true });
    expect(found).toMatchObject({ outcome: "confirmed", mutationId: lost.mutationId, record: { path: "notes/lost.md" } });
    expect(replica.allRecords).toHaveLength(2);
  });

  it("says a mutation the replica never captured was not saved", async () => {
    const client = await open(replicaWith());
    const id = uuidv7();
    expect(await client.settle(id)).toMatchObject({ outcome: "rejected", mutationId: id, problem: { code: "not_found" } });
  });

  it("rejects with cancelled when the caller aborts the wait", async () => {
    const replica = replicaWith({ confirmDelayMs: null }), client = await open(replica);
    const write = await client.create({ path: "notes/a.md", body: "a" });
    const abort = new AbortController();
    const settling = client.settle(write, { timeoutMs: 5_000, signal: abort.signal });
    abort.abort();
    await expect(settling).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("settle over receipts", () => {
  const id = uuidv7(), recordId = uuidv7();
  const record = { id: recordId, path: "notes/a.md", state: { state: "confirmed", confirmedSeq: 1 } } as RecordView;
  const stub = (answers: { receipt?: Receipt | Error; awaited?: Receipt | Error; get?: RecordView | Error }) => ({
    calls: [] as string[],
    async receipt(this: { calls: string[] }) { this.calls.push("receipt"); if (answers.receipt instanceof Error) throw answers.receipt; return answers.receipt!; },
    async awaitReceipt(this: { calls: string[] }) { this.calls.push("await"); if (answers.awaited instanceof Error) throw answers.awaited; return answers.awaited!; },
    async get(this: { calls: string[] }) { this.calls.push("get"); if (answers.get instanceof Error) throw answers.get; return answers.get!; },
    async getContract(): Promise<never> { throw new Error("not asked"); },
  });
  const settle = (client: ReturnType<typeof stub>, input: Parameters<typeof settleWrite>[1], options?: Parameters<typeof settleWrite>[2]) =>
    settleWrite(client as unknown as Parameters<typeof settleWrite>[0], input, options);

  it("reports a confirmed write that lost values as conflicted, with what it lost, and still reads back", async () => {
    const conflicts = [{ kind: "field", id: recordId, field: "title", kept: { value: "theirs" }, lost: { value: "mine" } }] as unknown as Receipt["conflicts"];
    const client = stub({ awaited: { mutation: id, state: "confirmed", status: "conflicted", conflicts }, get: record });
    const settled = await settle(client, new Write({ mutation: id, state: "pending" }), { read: { record: recordId } });
    expect(settled).toMatchObject({ outcome: "conflicted", conflicts, record: { id: recordId } });
  });

  it("reports the replica's unknown receipt as unknown", async () => {
    const client = stub({ receipt: { mutation: id, state: "unknown" } });
    expect(await settle(client, id)).toMatchObject({ outcome: "unknown", mutationId: id, problem: { code: "outcome_unknown" } });
  });

  it("keeps a kept write unknown when its record cannot be read back, and repeats only the read", async () => {
    const confirmed: Receipt = { mutation: id, state: "confirmed" };
    const failing = stub({ receipt: confirmed, get: mdbaseError("unavailable", "busy") });
    const first = await settle(failing, id, { read: { record: recordId } });
    expect(first).toMatchObject({ outcome: "unknown", receipt: { state: "confirmed" }, problem: { reason: "readback_failed" } });
    const working = stub({ receipt: confirmed, get: record });
    expect(await settle(working, id, { read: { record: recordId } })).toMatchObject({ outcome: "confirmed", record: { id: recordId } });
    expect(working.calls).toEqual(["receipt", "get"]);
  });

  it("stays saved_on_device when the wait itself fails: the write is on this device", async () => {
    const client = stub({ awaited: mdbaseError("unavailable", "link dropped") });
    expect(await settle(client, new Write({ mutation: id, state: "pending" }))).toMatchObject({ outcome: "saved_on_device" });
  });

  it("refuses to guess which record to read back", async () => {
    const client = stub({ receipt: { mutation: id, state: "confirmed" } });
    await expect(settle(client, id, { read: true })).rejects.toMatchObject({ code: "invalid_request", mutationId: id });
    expect(client.calls).toEqual(["receipt"]);
  });

  it("rejects another mutation's receipt as an internal failure that names the original", async () => {
    const client = stub({ receipt: { mutation: uuidv7(), state: "confirmed" } });
    await expect(settle(client, id)).rejects.toMatchObject({ code: "internal", mutationId: id });
  });

  it("passes through a failure that is not a write's outcome", async () => {
    const client = stub({});
    await expect(settle(client, Promise.reject(new TypeError("bug")))).rejects.toBeInstanceOf(TypeError);
  });
});
