// One status object: `summarizeSync` over the replica's status, the write
// ledger and what the host knows about the network.
import { describe, expect, it } from "vitest";
import { summarizeSync, type SyncInput } from "../src/status.js";
import type { SyncStatus } from "../src/wire.js";
import type { WriteLedgerEntry, WriteLedgerSnapshot } from "../src/write-ledger.js";

const synced: SyncStatus = { mode: "synced", confirmedThrough: 5, headKnown: 5, pending: 0, holds: 0, unresolved: 0, connection: "online", incidents: [] };
const local: SyncStatus = { ...synced, mode: "local_only", confirmedThrough: 0, headKnown: 0, connection: "offline" };
const write = (state: WriteLedgerEntry["state"]): WriteLedgerEntry => ({ mutationId: "0192f3a4-6000-7abc-8def-0123456789ab", records: [], createdAt: 1, state });
const ledger = (pending = 0, rejected = 0): WriteLedgerSnapshot => ({
  pending: Array.from({ length: pending }, () => write("pending")), rejected: Array.from({ length: rejected }, () => write("rejected")),
  saveState: rejected ? "rejected" : pending ? "saving" : "saved", restored: true,
});
const sync = (status: Partial<SyncStatus>, rest: Omit<SyncInput, "status"> = {}) => summarizeSync({ status: { ...synced, ...status }, ...rest });

describe("summarizeSync", () => {
  it("says saved only when nothing is waiting and nothing is arriving", () => {
    expect(sync({})).toEqual({
      state: "saved", connection: "online", health: null, live: null, pending: 0, pendingFor: null, writes: null,
      attention: [], conflicts: 0, holds: 0, incidents: [],
    });
    expect(sync({ headKnown: 9 }).state).toBe("catching_up");
    expect(sync({ installing: { done: 1, total: 4 } }).state).toBe("catching_up");
  });

  it("counts a change as pending from either the replica or the ledger, at once", () => {
    expect(sync({ pending: 2 })).toMatchObject({ state: "saving", pending: 2 });
    // The ledger knows a write before the replica's count rises.
    expect(sync({}, { writes: ledger(1) })).toMatchObject({ state: "saving", pending: 1 });
    expect(sync({ pending: 3 }, { writes: ledger(1) }).pending).toBe(3);
  });

  it("ages pending changes: a moment, a while, long", () => {
    const at = (pendingForMs?: number) => sync({ pending: 1 }, pendingForMs === undefined ? {} : { pendingForMs }).pendingFor;
    expect([at(0), at(1_999), at(2_000), at(29_999), at(30_000)]).toEqual(["moment", "moment", "while", "while", "long"]);
    // A host that keeps no clock never hides a pending change as momentary.
    expect(at()).toBe("while");
    expect(sync({}, { pendingForMs: 40_000 }).pendingFor).toBeNull();
  });

  it("is offline only when the device is: an unreachable service is reconnecting", () => {
    expect(sync({}, { transport: { kind: "offline" } })).toMatchObject({ state: "offline", connection: "offline", health: "offline" });
    expect(sync({}, { online: false })).toMatchObject({ state: "offline", connection: "offline", health: null });
    expect(sync({ connection: "offline" })).toMatchObject({ state: "offline", connection: "offline" });
    for (const kind of ["unreachable", "server_busy", "rate_limited", "auth"] as const) {
      expect(sync({}, { transport: { kind } })).toMatchObject({ state: "reconnecting", connection: "reconnecting", health: kind });
    }
    expect(sync({ connection: "connecting" })).toMatchObject({ state: "reconnecting", connection: "reconnecting" });
    // `navigator.onLine === true` proves nothing; the browser saying offline outranks a stale health.
    expect(sync({}, { online: true }).connection).toBe("online");
    expect(sync({}, { online: false, transport: { kind: "server_busy" } }).connection).toBe("offline");
  });

  it("reads pending changes that cannot be delivered as saved on this device, never as stuck saving", () => {
    expect(sync({ pending: 2 }, { transport: { kind: "offline" } }).state).toBe("saved_on_device");
    expect(sync({ pending: 2 }, { transport: { kind: "server_busy", retryAfterMs: 30_000 } }).state).toBe("saved_on_device");
    expect(sync({ pending: 2 }, { online: false }).state).toBe("saved_on_device");
    expect(sync({ pending: 2, connection: "offline" }).state).toBe("saved_on_device");
    // Only connecting: the change goes as soon as the replica is through.
    expect(sync({ pending: 2, connection: "connecting" }).state).toBe("reconnecting");
  });

  it("follows the app's own link to the replica", () => {
    expect(sync({}, { link: "open" }).connection).toBe("online");
    expect(sync({}, { link: "reconnecting" })).toMatchObject({ state: "reconnecting", connection: "reconnecting" });
    expect(sync({ pending: 1 }, { link: "closed" }).state).toBe("saved_on_device");
    expect(summarizeSync({ status: local, link: "reconnecting" }).connection).toBe("reconnecting");
  });

  it("lists what needs the person, most pressing first, and nothing else", () => {
    expect(sync({ pending: 1, holds: 2, unresolved: 1, incidents: [{ kind: "quota_exceeded" }] }, {
      problem: "account_suspended", writes: ledger(1, 1), storageWarning: true, transport: { kind: "offline" },
    })).toMatchObject({
      state: "attention", attention: ["account_suspended", "rejected", "conflicts", "held", "incident", "storage_may_be_evicted"],
      connection: "offline", conflicts: 1, holds: 2, incidents: [{ kind: "quota_exceeded" }],
    });
    for (const problem of ["collection_not_yet_migrated", "collection_migrating", "update_required", "account_suspended"]) {
      expect(sync({ pending: 1, connection: "offline" }, { problem })).toMatchObject({ state: "attention", attention: [problem], pending: 1 });
    }
    // Any other problem belongs to the phase, not to sync.
    expect(sync({}, { problem: "collection_unavailable" }).attention).toEqual([]);
    // A storage warning is about pending changes: none pending, none shown.
    expect(sync({}, { storageWarning: true }).attention).toEqual([]);
  });

  it("local-only: saved on this device, with no service to reach or wait for", () => {
    expect(summarizeSync({ status: local, transport: { kind: "offline" }, online: false, live: false, problem: "account_suspended" })).toMatchObject({
      state: "saved", connection: "local", health: null, live: null, attention: [],
    });
    expect(summarizeSync({ status: { ...local, pending: 1 } }).state).toBe("saving");
    expect(summarizeSync({ status: { ...local, holds: 1 } })).toMatchObject({ state: "attention", attention: ["held"] });
  });

  it("carries whether other devices' changes arrive live", () => {
    expect(sync({}, { live: false })).toMatchObject({ state: "saved", live: false });
    expect(sync({}, { live: true }).live).toBe(true);
  });
});
