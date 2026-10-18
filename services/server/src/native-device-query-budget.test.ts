import { describe, expect, it, vi } from "vitest";
import { nativeDevices } from "./features/next/native-grant-target.js";

const account = "10000000-0000-4000-8000-000000000001";
const collection = "20000000-0000-4000-8000-000000000001";

describe("native serving-device discovery query budget", () => {
  it.each([1, 3])("discovers %i enrolled devices without per-device SQL", async size => {
    const devices = Array.from({ length: size }, (_, index) => ({
      device_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      kind: "desktop", sign_pk: Buffer.alloc(32, 1), kem_pk: Buffer.alloc(32, 2), noise_pk: Buffer.alloc(32, 3),
      connector_id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      relay_generation: "1", last_active_ms: null, update_required: false,
    }));
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("WITH devices AS")) return { rows: devices.map(({ sign_pk: _sign, kem_pk: _kem, ...device }) => ({ collection_id: collection, ...device })) };
      if (sql.includes("FROM next_devices d")) return { rows: devices };
      if (sql.includes("SELECT o.ops, b.seq, b.item, b.state")) return { rows: [{ state: "appended" }] };
      if (sql.includes("SELECT 1 FROM next_policy_outbox")) return { rows: [] };
      throw new Error("Unexpected synthetic device-discovery query");
    });
    expect(await nativeDevices({ query }, collection, account)).toHaveLength(size);
    expect(query.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
