import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { tokenHash } from "../../security.js";
import { clientNoiseKeyMessage } from "./client-key.js";
import { clientKeyAttachMessage, registerClientKeyAttachRoute } from "./client-key-attach.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

function signingKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { privateKey, publicKey: Buffer.concat([Buffer.of(4), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url") };
}
const sig = (key: KeyObject, message: Buffer) => sign("sha256", message, { key, dsaEncoding: "ieee-p1363" }).toString("base64url");

function attachBody(input: { grantId: string; authorizationId: string; key: KeyObject; requestKey?: KeyObject; expiresAt?: string }) {
  const publicKey = randomBytes(32), nonce = randomBytes(32);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  return {
    grant_id: input.grantId,
    public_key: publicKey.toString("base64url"),
    attestation: sig(input.key, clientNoiseKeyMessage(input.authorizationId, publicKey)),
    nonce: nonce.toString("base64url"),
    expires_at: expiresAt,
    signature: sig(input.requestKey ?? input.key, clientKeyAttachMessage(input.grantId, publicKey, expiresAt, nonce))
  };
}

describe("client key attach request", () => {
  it("pins the domain-separated message bytes", () => {
    const message = clientKeyAttachMessage("4c18af2e-b04a-4b77-b83e-493c3695962e", Buffer.alloc(32, 0x0c), "2026-10-12T00:00:00.000Z", Buffer.alloc(32, 0x0d));
    expect(message.toString("hex")).toBe(
      Buffer.from("mdbase-next client noise key attach v1\0").toString("hex")
      + "00000010" + "4c18af2eb04a4b77b83e493c3695962e"
      + "00000020" + "0c".repeat(32)
      + "00000018" + Buffer.from("2026-10-12T00:00:00.000Z").toString("hex")
      + "00000020" + "0d".repeat(32)
    );
  });
});

describePostgres("client key attach route", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const app = Fastify();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Attach tests require a dedicated local test database.");
    schema = `mdbase_next_key_attach_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerClientKeyAttachRoute(app, { db });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function grant() {
    const id = await localGrantFixture(db), key = signingKey(), authorizationId = randomUUID(), token = `tok_${randomUUID()}`;
    await db.query(
      `UPDATE grants SET activated_at = now(),
         application_authorization = jsonb_set(jsonb_set(application_authorization, '{binding,authorization_id}', to_jsonb($2::text)),
           '{binding,grant_signing_public_key}', to_jsonb($3::text))
       WHERE id = $1`, [id, authorizationId, key.publicKey]);
    await db.query("INSERT INTO access_tokens (id, token_hash, grant_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')", [randomUUID(), tokenHash(token), id]);
    const attach = (body: object) => app.inject({ method: "POST", url: "/v1/next/grants/client-key", headers: { authorization: `Bearer ${token}` }, payload: body });
    return { id, key, authorizationId, attach };
  }
  const keyCount = async (id: string) => (await db.query("SELECT 1 FROM next_grant_client_keys WHERE grant_id = $1", [id])).rows.length;

  it("attaches once; a replay or a second key is refused", async () => {
    const g = await grant();
    const body = attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: g.key.privateKey });
    const first = await g.attach(body);
    expect(first.statusCode).toBe(200);
    expect(await keyCount(g.id)).toBe(1);
    const replay = await g.attach(body);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("client_key_present");
    expect((await g.attach(attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: g.key.privateKey }))).statusCode).toBe(409);
    const stored = (await db.query<{ client_pk: Buffer }>("SELECT client_pk FROM next_grant_client_keys WHERE grant_id = $1", [g.id])).rows[0];
    expect(stored.client_pk.toString("base64url")).toBe(body.public_key);
  });

  it("refuses an expired or too long-lived request", async () => {
    const g = await grant();
    for (const expiresAt of [new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 10 * 60_000).toISOString()]) {
      const response = await g.attach(attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: g.key.privateKey, expiresAt }));
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("attach_expired");
    }
    expect(await keyCount(g.id)).toBe(0);
  });

  it("refuses a request or attestation not signed by the grant's own key", async () => {
    const g = await grant(), other = signingKey();
    for (const body of [
      attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: g.key.privateKey, requestKey: other.privateKey }),
      attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: other.privateKey, requestKey: g.key.privateKey }),
      attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: other.privateKey })
    ]) {
      const response = await g.attach(body);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_client_key");
    }
    // Signed for another grant: bound to grant_id.
    const elsewhere = await grant();
    const crossed = attachBody({ grantId: elsewhere.id, authorizationId: g.authorizationId, key: g.key.privateKey });
    expect((await g.attach(crossed)).statusCode).toBe(401);
    expect(await keyCount(g.id)).toBe(0);
  });

  it("refuses a revoked grant", async () => {
    const g = await grant();
    await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [g.id]);
    const response = await g.attach(attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: g.key.privateKey }));
    expect(response.statusCode).toBe(401);
    expect(await keyCount(g.id)).toBe(0);
  });

  it("refuses a suspended user", async () => {
    const g = await grant();
    await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [g.id]);
    const response = await g.attach(attachBody({ grantId: g.id, authorizationId: g.authorizationId, key: g.key.privateKey }));
    expect(response.statusCode).toBe(401);
    expect(await keyCount(g.id)).toBe(0);
  });
});
