import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "./db.js";
import {
  buildPolicySnapshot,
  PolicySequenceExhaustedError,
  resolvePolicyAppliedAck
} from "./relay-policy.js";
import type { DatabasePool } from "./database-types.js";

const databases: DatabasePool[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.end()));
});

describe("connector policy sequence", () => {
  it("atomically emits MAX_SAFE_INTEGER once then fails terminally without precision loss", async () => {
    const db = await createDatabase("memory");
    databases.push(db);
    const userId = randomUUID();
    const connectorId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, 'policy@example.com', 'Policy')",
      [userId]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash, policy_sequence)
       VALUES ($1, $2, 'Laptop', 'hash', $3::bigint)`,
      [connectorId, userId, String(Number.MAX_SAFE_INTEGER - 1)]
    );

    const terminal = await buildPolicySnapshot(db, connectorId, 60_000);
    expect(terminal?.sequence).toBe(Number.MAX_SAFE_INTEGER);
    await expect(buildPolicySnapshot(db, connectorId, 60_000))
      .rejects.toBeInstanceOf(PolicySequenceExhaustedError);
    const stored = await db.query<{ policy_sequence: string | number }>(
      "SELECT policy_sequence FROM connectors WHERE id = $1",
      [connectorId]
    );
    expect(BigInt(stored.rows[0]!.policy_sequence)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("rejects a stale reconnect acknowledgement and requires the fresh PG generation", async () => {
    const db = await createDatabase("memory");
    databases.push(db);
    const userId = randomUUID();
    const connectorId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, 'ack@example.com', 'Ack')",
      [userId]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash, relay_generation)
       VALUES ($1, $2, 'Laptop', 'hash', 2)`,
      [connectorId, userId]
    );
    const staleReject = vi.fn();
    await resolvePolicyAppliedAck({
      db,
      requestId: randomUUID(),
      message: { revision: "fresh", ok: true },
      expectedRevision: "fresh",
      connectorId,
      generation: "1",
      isStillCurrent: () => true,
      resolve: vi.fn(),
      reject: staleReject
    });
    expect(staleReject).toHaveBeenCalledWith(expect.objectContaining({
      code: "stale_policy_acknowledgement"
    }));

    const resolve = vi.fn();
    await resolvePolicyAppliedAck({
      db,
      requestId: randomUUID(),
      message: { revision: "fresh", ok: true },
      expectedRevision: "fresh",
      connectorId,
      generation: "2",
      isStillCurrent: () => true,
      resolve,
      reject: vi.fn()
    });
    expect(resolve).toHaveBeenCalledOnce();
  });
});
