// The write ledger over MemoryReplica: persistence across a reload and save().
import { afterEach, describe, expect, it } from "vitest";
import { connect, memoryWriteLedgerStore, type MdbaseClient, type WriteLedgerStore } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";

const clients: MdbaseClient[] = [];
afterEach(() => { for (const c of clients.splice(0)) c.close(); });
async function open(replica: MemoryReplica, ledger: WriteLedgerStore) {
  const client = await connect({ connector: replica.connector(), app: { name: "ledger-test", version: "test" }, reconnect: false, ledger });
  clients.push(client);
  return client;
}
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); expect(check()).toBe(true); };

describe("write ledger", () => {
  it("keeps a refused write across a reload until it is acknowledged, and drops settled ones", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null }), store = memoryWriteLedgerStore();
    const first = await open(replica, store);
    const refused = await first.create({ path: "notes/refused.md", body: "x" });
    const kept = await first.create({ path: "notes/kept.md", body: "y" });
    expect(first.ledger.getSnapshot().pending).toHaveLength(2);
    replica.reject(refused.mutationId);
    await until(() => first.ledger.getSnapshot().saveState === "rejected");
    first.close();
    replica.confirmAll();

    const second = await open(replica, store);
    await until(() => second.ledger.getSnapshot().restored);
    const snap = second.ledger.getSnapshot();
    expect(snap.rejected.map((e) => e.mutationId)).toEqual([refused.mutationId]);
    expect(snap.rejected[0]!.problem?.code).toBe("conflict");
    expect(snap.pending.map((e) => e.mutationId)).not.toContain(kept.mutationId);
    expect(second.ledger.stateOf(refused.records[0]!.id)).toBe("rejected");
    await second.ledger.acknowledge(refused.mutationId);
    expect(second.ledger.getSnapshot().saveState).toBe("saved");
    expect(await store.list()).toEqual([]);
  });

  it("shows a write another tab of the session made as unsaved until it confirms", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const watching = await open(replica, memoryWriteLedgerStore()), writing = await open(replica, memoryWriteLedgerStore());
    await until(() => watching.ledger.getSnapshot().restored);
    const w = await writing.create({ path: "notes/other-tab.md", body: "z" });
    await until(() => watching.ledger.getSnapshot().pending.some((e) => e.mutationId === w.mutationId));
    expect(watching.ledger.getSnapshot().saveState).toBe("saving");
    replica.confirmAll();
    await until(() => watching.ledger.getSnapshot().saveState === "saved");
  });

  it("a create retried under the same intent after a lost reply lands once", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const client = await open(replica, memoryWriteLedgerStore());
    const first = await client.create({ path: "notes/draft.md", body: "a" }, { intent: "draft-1" });
    const retry = await client.create({ path: "notes/draft.md", body: "a" }, { intent: "draft-1" });
    expect(retry.mutationId).toBe(first.mutationId);
    replica.confirmAll();
    const again = await client.create({ path: "notes/draft.md", body: "a" }, { intent: "draft-1" });
    expect(again.mutationId).toBe(first.mutationId);
    const other = await client.create({ path: "notes/other.md", body: "b" }, { intent: "draft-2" });
    expect(other.mutationId).not.toBe(first.mutationId);
    replica.confirmAll();
    const paths = (await client.query({})).records.map((r) => r.path).sort();
    expect(paths).toEqual(["notes/draft.md", "notes/other.md"]);
  });

  it("save() reports a write that outlives its wait as saved on the device, never as unknown", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const client = await open(replica, memoryWriteLedgerStore());
    const slow = await client.save(client.create({ path: "notes/slow.md", body: "a" }), { timeoutMs: 20, readBack: true });
    expect(slow).toMatchObject({ outcome: "saved_on_device", record: { path: "notes/slow.md" } });
    replica.confirmAll();
    await until(() => client.ledger.getSnapshot().pending.length === 0);
    const fast = new MemoryReplica({ confirmDelayMs: 0 });
    const other = await open(fast, memoryWriteLedgerStore());
    expect(await other.save(other.create({ path: "notes/fast.md", body: "b" }))).toMatchObject({ outcome: "confirmed" });
  });
});
