import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { randomToken, tokenHash } from "../../security.js";
import {
  connectorFromRequest,
  requireInstallationDeviceConnector,
} from "../../platform/request-authentication.js";
import { deviceRegistrationDigest } from "../next/devices.js";
import { ed25519RawPublicKey } from "../next/policy-keys.js";
import { registerNextDeviceRoutes } from "../next/device-routes.js";
import { registerConnectorPairingRoutes } from "./pairing-routes.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved =
  process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const rawX = () =>
  (
    generateKeyPairSync("x25519").publicKey.export({
      type: "spki",
      format: "der",
    }) as Buffer
  )
    .subarray(-32)
    .toString("hex");

describePg("installation device sign-in on daemon pairing", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (
      !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
      !/test/i.test(url.pathname)
    )
      throw new Error("Requires dedicated local test Postgres.");
    schema = `installation_pairing_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await app.register(cookie);
    registerConnectorPairingRoutes(app, {
      db,
      publicUrl: "https://connect.test",
      installationDevices: true,
    });
    registerNextDeviceRoutes(app, {
      db,
      log: { controlItemAt: async () => null },
    });
    app.get("/test/installation-scope", async (request, reply) => {
      const identity = await requireInstallationDeviceConnector(
        request,
        reply,
        db,
      );
      if (!identity) return reply;
      return identity;
    });
    app.get("/test/controller-scope", async (request, reply) => {
      const identity = await connectorFromRequest(request, db);
      return identity ?? reply.code(401).send({ error: "invalid_controller" });
    });
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await db?.end();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });
  async function account() {
    const user = randomUUID(),
      session = randomUUID(),
      token = randomToken("session");
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Owner')", [
      user,
      `${user}@example.test`,
    ]);
    await db.query(
      "INSERT INTO sessions(id,user_id,token_hash,provider,account_session_epoch,expires_at) VALUES($1,$2,$3,'password',(SELECT session_epoch FROM users WHERE id=$2),now()+interval '1 hour')",
      [session, user, tokenHash(token)],
    );
    return { user, session, headers: { cookie: `mdbase_session=${token}` } };
  }
  function original(kind: "app-runtime" | "mobile" = "app-runtime") {
    return {
      connector_name: "Test browser",
      installation: {
        request_id: randomUUID(),
        pairing_secret: randomToken("pair"),
        installation_id: randomUUID(),
        device_id: randomUUID(),
        kind,
      },
    };
  }
  function channel(input: ReturnType<typeof original>) {
    const base = `/v1/pairing-requests/${input.installation.request_id}`;
    const bearer = {
      authorization: `Bearer ${input.installation.pairing_secret}`,
    };
    return {
      base,
      bearer,
      exchange: () =>
        app.inject({
          method: "POST",
          url: `${base}/exchange`,
          headers: bearer,
        }),
    };
  }
  async function start(input: ReturnType<typeof original>) {
    const result = await app.inject({
      method: "POST",
      url: "/v1/pairing-requests",
      payload: input,
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().verification_uri).toBe(
      `https://connect.test/pair/${input.installation.request_id}`,
    );
    expect(result.headers["cache-control"]).toBe("no-store");
    return channel(input);
  }
  async function attest(
    input: ReturnType<typeof original>,
    selected: Record<string, string>,
    privateKey = generateKeyPairSync("ed25519").privateKey,
  ) {
    const sign_pk = Buffer.from(ed25519RawPublicKey(privateKey)).toString(
        "hex",
      ),
      kem_pk = rawX(),
      noise_pk = rawX();
    const sig = sign(
      null,
      deviceRegistrationDigest({
        challenge: Buffer.from(selected.challenge, "hex"),
        connectorId: selected.connector_id,
        deviceId: input.installation.device_id,
        signPk: Buffer.from(sign_pk, "hex"),
        kemPk: Buffer.from(kem_pk, "hex"),
        noisePk: Buffer.from(noise_pk, "hex"),
      }),
      privateKey,
    ).toString("hex");
    const payload = { sign_pk, kem_pk, noise_pk, sig };
    const flow = channel(input);
    const result = await app.inject({
      method: "POST",
      url: `${flow.base}/attest`,
      headers: flow.bearer,
      payload,
    });
    return { payload, result };
  }
  async function prepared(kind: "app-runtime" | "mobile" = "app-runtime") {
    const owner = await account(),
      input = original(kind),
      flow = await start(input);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/select-account`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(200);
    const selected = (await flow.exchange()).json();
    expect(selected.status).toBe("account_selected");
    expect(selected.account_id).toBe(owner.user);
    expect(selected.token).toBeUndefined();
    const proof = await attest(input, selected);
    expect(proof.result.statusCode).toBe(200);
    return { owner, input, flow, selected, proof };
  }
  it.each(["app-runtime", "mobile"] as const)(
    "preserves exact %s request through concurrent/lost committed exchange without another device",
    async (kind) => {
      const { owner, input, flow, selected, proof } = await prepared(kind);
      expect((await flow.exchange()).json().status).toBe("awaiting_approval");
      const inspect = await app.inject({
        method: "GET",
        url: flow.base,
        headers: owner.headers,
      });
      expect(inspect.json().pairing.fingerprint).toMatch(
        /^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/,
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${flow.base}/approve`,
            headers: owner.headers,
          })
        ).statusCode,
      ).toBe(200);
      // First response is intentionally discarded; concurrent subsequent exchanges
      // must reproduce its original credential/public registration, never reissue.
      const discarded = (await flow.exchange()).json();
      const replies = await Promise.all(
        Array.from({ length: 4 }, () => flow.exchange()),
      );
      for (const reply of replies) {
        expect(reply.statusCode).toBe(200);
        expect(reply.json()).toEqual(discarded);
      }
      expect(discarded.registration).toMatchObject({
        device_id: input.installation.device_id,
        sign_pk: proof.payload.sign_pk,
        kem_pk: proof.payload.kem_pk,
        noise_pk: proof.payload.noise_pk,
      });
      expect(discarded.connector_id).toBe(selected.connector_id);
      const counts = await db.query(
        "SELECT (SELECT count(*)::int FROM next_devices WHERE connector_id=$1) AS devices,(SELECT count(*)::int FROM installation_device_credentials WHERE connector_id=$1) AS credentials",
        [selected.connector_id],
      );
      expect(counts.rows[0]).toEqual({ devices: 1, credentials: 1 });
      expect(
        (
          await db.query("SELECT kind FROM next_devices WHERE id=$1", [
            input.installation.device_id,
          ])
        ).rows[0].kind,
      ).toBe(kind);
      await db.query(
        "UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [input.installation.request_id],
      );
      expect((await flow.exchange()).json()).toEqual(discarded); // committed outcome survives approval-window expiry
      const headers = { authorization: `Bearer ${discarded.token}` };
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/test/installation-scope",
            headers,
          })
        ).json(),
      ).toEqual({ id: selected.connector_id, user_id: owner.user });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/next/devices/challenge",
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/test/controller-scope",
            headers,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/next/devices",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [
        selected.connector_id,
      ]);
      expect((await flow.exchange()).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/test/installation-scope",
            headers,
          })
        ).statusCode,
      ).toBe(401);
    },
  );
  it("refuses approval before native-key attestation, unknown account and wrong secret", async () => {
    const owner = await account(),
      other = await account(),
      input = original(),
      flow = await start(input);
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/approve`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/select-account`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/select-account`,
          headers: other.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/exchange`,
          headers: { authorization: `Bearer ${randomToken("pair")}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/approve`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await db.query("SELECT id FROM next_devices WHERE id=$1", [
          input.installation.device_id,
        ])
      ).rows,
    ).toEqual([]);
  });
  it("rejects original kind/installation/device/secret/name drift without replacing stored actor", async () => {
    const input = original();
    await start(input);
    for (const field of [
      "kind",
      "installation_id",
      "device_id",
      "pairing_secret",
    ] as const) {
      const changed = {
        ...input,
        installation: {
          ...input.installation,
          [field]:
            field === "kind"
              ? "mobile"
              : field === "pairing_secret"
                ? randomToken("pair")
                : randomUUID(),
        },
      };
      const reply = await app.inject({
        method: "POST",
        url: "/v1/pairing-requests",
        payload: changed,
      });
      expect([404, 409]).toContain(reply.statusCode);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/pairing-requests",
          payload: { ...input, connector_name: "Replacement" },
        })
      ).statusCode,
    ).toBe(409);
    expect((await start(input)).base).toBe(channel(input).base);
  });
  it("attestation is exact-key/signature idempotent and foreign-key substitution refuses", async () => {
    const { input, flow, selected, proof } = await prepared();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/attest`,
          headers: flow.bearer,
          payload: proof.payload,
        })
      ).statusCode,
    ).toBe(200);
    expect((await attest(input, selected)).result.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/attest`,
          headers: flow.bearer,
          payload: { ...proof.payload, sig: "00".repeat(64) },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await db.query(
          "SELECT sign_pk FROM installation_device_pairings WHERE pairing_id=$1",
          [input.installation.request_id],
        )
      ).rows[0].sign_pk.toString("hex"),
    ).toBe(proof.payload.sign_pk);
  });
  it("denial, expired pending, session revocation and suspension cannot issue credentials", async () => {
    const { owner, input, flow } = await prepared();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${flow.base}/deny`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect((await flow.exchange()).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/pairing-requests",
          payload: input,
        })
      ).statusCode,
    ).toBe(404);
    const expired = original(),
      exp = await start(expired);
    await db.query(
      "UPDATE pairing_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.installation.request_id],
    );
    expect((await exp.exchange()).statusCode).toBe(404);
    const revoked = await prepared();
    await db.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [
      revoked.owner.session,
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${revoked.flow.base}/approve`,
          headers: revoked.owner.headers,
        })
      ).statusCode,
    ).toBe(401);
    await db.query("UPDATE users SET suspended_at=now() WHERE id=$1", [
      revoked.owner.user,
    ]);
    expect((await revoked.flow.exchange()).statusCode).toBe(403);
  });
  it("strict accounts refuse selection and a strict transition blocks unconsumed approval/exchange", async () => {
    const strict = await account(), input = original(), flow = await start(input);
    await db.query("INSERT INTO next_account_keys(user_id,mode,version) VALUES($1,'strict',1)", [strict.user]);
    const refusal = await app.inject({ method: "POST", url: `${flow.base}/select-account`, headers: strict.headers });
    expect(refusal.statusCode).toBe(403);
    expect(refusal.body).toContain("strict_device_approval");
    expect((await flow.exchange()).json()).toEqual({ status: "pending" });
    const transition = await prepared();
    expect((await app.inject({ method: "POST", url: `${transition.flow.base}/approve`, headers: transition.owner.headers })).statusCode).toBe(200);
    await db.query("INSERT INTO next_account_keys(user_id,mode,version) VALUES($1,'strict',1)", [transition.owner.user]);
    expect((await transition.flow.exchange()).statusCode).toBe(403);
    expect((await db.query("SELECT id FROM next_devices WHERE id=$1", [transition.input.installation.device_id])).rows).toEqual([]);
  });
  it("keeps original daemon pairing response and one-shot exchange semantics", async () => {
    const owner = await account();
    const first = await app.inject({
      method: "POST",
      url: "/v1/pairing-requests",
      payload: { connector_name: "Desktop" },
    });
    expect(first.statusCode).toBe(201);
    const body = first.json(),
      base = `/v1/pairing-requests/${body.pairing_id}`,
      headers = { authorization: `Bearer ${body.pairing_secret}` };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/approve`,
          headers: owner.headers,
        })
      ).json().deep_link,
    ).toMatch(/^mdbase-connect:\/\/paired/);
    const exchange = await app.inject({
      method: "POST",
      url: `${base}/exchange`,
      headers,
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.json().token).toMatch(/^con_/);
    expect(
      (await app.inject({ method: "POST", url: `${base}/exchange`, headers }))
        .statusCode,
    ).toBe(409);
  });
});
