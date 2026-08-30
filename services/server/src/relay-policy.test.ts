import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "./db.js";
import { canonicalJson, canonicalSha256 } from "./canonical-json.js";
import {
  buildPolicySnapshot,
  normalizePolicyGrant,
  policyGrantCreatedAtIso,
  PolicySequenceExhaustedError,
  resolvePolicyAppliedAck
} from "./relay-policy.js";
import type { DatabasePool } from "./database-types.js";

const databases: DatabasePool[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.end()));
});

describe("connector policy sequence", () => {
  it("matches the shared Rust protocol-v1 canonical fixture", () => {
    const fixture = JSON.parse(readFileSync(new URL(
      "../../../test-fixtures/protocol-v1-policy-canonical.json",
      import.meta.url
    ), "utf8")) as Record<string, any>;
    const grants = fixture.db_like_grants
      .map((stored: Parameters<typeof normalizePolicyGrant>[0]) =>
        normalizePolicyGrant(stored))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const wireBody = {
      connector_id: fixture.normalized_wire_body.connector_id,
      sequence: fixture.normalized_wire_body.sequence,
      lease_issued_at_ms: fixture.normalized_wire_body.lease_issued_at_ms,
      lease_expires_at_ms: fixture.normalized_wire_body.lease_expires_at_ms,
      grants
    };
    const authorityBody = { connector_id: wireBody.connector_id, grants };

    expect(wireBody).toEqual(fixture.normalized_wire_body);
    expect(canonicalJson(wireBody)).toBe(fixture.normalized_wire_canonical);
    expect(canonicalJson(authorityBody)).toBe(fixture.authority_canonical);
    expect(canonicalSha256(wireBody)).toBe(fixture.revision);
    expect(canonicalSha256(authorityBody)).toBe(fixture.authority_digest);
    expect(fixture.revision)
      .toBe("sha256:ccfe7bb1eb75acbec1abe0ee2e8a0c13f1d2be3e2cb47aa30cf6ba6bc3d982ea");
    expect(fixture.authority_digest)
      .toBe("sha256:141ae510bcd2582cc075046327940a622d68a87355e1f11fb7358bf5fe0803fd");
  });

  it("rejects invalid policy grant dates without normalizing garbage", () => {
    expect(() => policyGrantCreatedAtIso("not-a-date")).toThrow(
      "Policy grant created_at is invalid."
    );
    expect(() => policyGrantCreatedAtIso(new Date(Number.NaN))).toThrow(
      "Policy grant created_at is invalid."
    );
    expect(policyGrantCreatedAtIso("2026-08-29T00:51:04.895Z"))
      .toBe("2026-08-29T00:51:04.895Z");
  });

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
      mode: "lease_v1",
      initial: true,
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
      mode: "lease_v1",
      initial: true,
      isStillCurrent: () => true,
      resolve,
      reject: vi.fn()
    });
    expect(resolve).toHaveBeenCalledOnce();
    const adopted = await db.query<{
      policy_lease_adopted_at: Date | null;
      latest_policy_ack_mode: string | null;
      latest_policy_ack_generation: string | number | null;
    }>(
      `SELECT policy_lease_adopted_at, latest_policy_ack_mode,
              latest_policy_ack_generation
       FROM connectors WHERE id = $1`,
      [connectorId]
    );
    expect(adopted.rows[0]?.policy_lease_adopted_at).not.toBeNull();
    expect(adopted.rows[0]?.latest_policy_ack_mode).toBe("lease_v1");
    expect(Number(adopted.rows[0]?.latest_policy_ack_generation)).toBe(2);
  });
});
