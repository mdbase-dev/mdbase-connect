import { describe, expect, it } from "vitest";
import { initialSyncWait, keyWaitDetail } from "../src/app-host/initial-sync.js";
import type { SyncStatus } from "../src/wire.js";

const status = (incidents: SyncStatus["incidents"]): SyncStatus => ({
  mode: "synced", confirmedThrough: 2, headKnown: 5, pending: 0, holds: 0, unresolved: 0, connection: "online", incidents,
});

describe("key wait detail", () => {
  it("names the replica's read-ahead reason and positions", () => {
    const s = status([{kind: "waiting_for_key", details: new Map<string, unknown>([["position", 3n], ["reason", "no_grant"], ["at", 5]]) as never}]);
    expect(initialSyncWait(s)).toBe("waiting_for_key");
    expect(keyWaitDetail(s)).toEqual({through: 2, head: 5, key: "no_grant", position: 3, at: 5});
  });

  it("omits the reason when no read-ahead reason is attached, and null when not waiting for a key", () => {
    expect(keyWaitDetail(status([{kind: "waiting_for_key"}]))).toEqual({through: 2, head: 5});
    expect(keyWaitDetail(status([]))).toBeNull();
  });
});
