import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createDatabase, type DatabasePool } from "../../db.js";
import { revocationFixture } from "../../local-grant-revocation.test.js";
import { buildPolicySnapshot, type LeasePolicySnapshot } from "../../relay-policy.js";
import {
  clientFingerprint,
  deviceBindDigest,
  deviceRegistrationDigest,
  DeviceRegistrationError,
  grantCapabilityGroups,
  issueDeviceChallenge,
  NextRelayDevices,
  registerDevice
} from "./devices.js";
import { ed25519RawPublicKey } from "./policy-keys.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

function deviceKeys() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, signPk: Buffer.from(ed25519RawPublicKey(privateKey)), kemPk: randomBytes(32), noisePk: randomBytes(32) };
}

async function registration(db: DatabasePool, connectorId: string, deviceId: string, keys: ReturnType<typeof deviceKeys>, kind = "desktop") {
  const { challenge } = await issueDeviceChallenge(db, connectorId);
  const digest = deviceRegistrationDigest({ challenge: Buffer.from(challenge, "hex"), connectorId, deviceId, ...keys });
  return {
    device_id: deviceId, kind, challenge,
    sign_pk: keys.signPk.toString("hex"), kem_pk: keys.kemPk.toString("hex"), noise_pk: keys.noisePk.toString("hex"),
    sig: Buffer.from(sign(null, digest, keys.privateKey)).toString("hex")
  };
}

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  return { socket: { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket, sent };
}

describe("device helpers", () => {
  it("derives v2 capability groups exactly and never offers offline.replica", () => {
    expect(grantCapabilityGroups(2, ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type", "create", "sync"]))
      .toEqual(["collection.read", "records.create"]);
    expect(grantCapabilityGroups(2, ["update"])).toEqual([]);
    expect(grantCapabilityGroups(1, ["read"])).toBeUndefined();
  });

  it("computes the daemon's client fingerprint", () => {
    const key = Buffer.alloc(32, 7);
    const expected = createHash("sha256").update("mdbase/v1/client-fp").update(key).digest("hex").slice(0, 16).match(/.{4}/g)!.join("-");
    expect(clientFingerprint(key)).toBe(expected);
  });
});

describePostgres("mdbase-next daemon devices", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Device tests require a dedicated local test database.");
    schema = `mdbase_next_devices_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("registers a device with proof of possession, once per challenge, with immutable keys", async () => {
    const connectorId = await revocationFixture(db);
    const connector = { id: connectorId, user_id: connectorId };
    const keys = deviceKeys();
    const deviceId = randomUUID();
    const body = await registration(db, connectorId, deviceId, keys);
    expect(await registerDevice(db, connector, body)).toEqual({ device_id: deviceId });
    await expect(registerDevice(db, connector, body)).rejects.toMatchObject({ code: "challenge_invalid" });
    expect(await registerDevice(db, connector, await registration(db, connectorId, deviceId, keys))).toEqual({ device_id: deviceId });
    await expect(registerDevice(db, connector, await registration(db, connectorId, deviceId, deviceKeys()))).rejects.toMatchObject({ code: "device_keys_changed" });
    await expect(registerDevice(db, connector, await registration(db, connectorId, randomUUID(), keys))).rejects.toMatchObject({ code: "device_already_bound" });
    const forged = { ...(await registration(db, connectorId, deviceId, keys)), sig: "00".repeat(64) };
    await expect(registerDevice(db, connector, forged)).rejects.toBeInstanceOf(DeviceRegistrationError);
    const other = await revocationFixture(db);
    const stolen = await registration(db, connectorId, randomUUID(), deviceKeys());
    await expect(registerDevice(db, { id: other, user_id: other }, stolen)).rejects.toMatchObject({ code: "invalid_device" });
  });

  it("binds a relay socket only with the device key, the session nonce and an active connector", async () => {
    const connectorId = await revocationFixture(db);
    const keys = deviceKeys();
    const deviceId = randomUUID();
    await registerDevice(db, { id: connectorId, user_id: connectorId }, await registration(db, connectorId, deviceId, keys));
    const devices = new NextRelayDevices(db);

    const legacy = fakeSocket();
    expect(devices.welcome(legacy.socket, ["policy-freshness-lease-v1"])).toEqual({});
    await devices.bind(legacy.socket, connectorId, "1", { device_id: deviceId, sig: "00".repeat(64) });
    expect(legacy.sent).toEqual([{ type: "device_bind_failed", reason: "invalid" }]);

    const { socket, sent } = fakeSocket();
    const nonce = Buffer.from(devices.welcome(socket, ["next_device_v1"]).device_nonce!, "hex");
    const wrongSession = Buffer.from(sign(null, deviceBindDigest(connectorId, "2", nonce), keys.privateKey)).toString("hex");
    await devices.bind(socket, connectorId, "1", { device_id: deviceId, sig: wrongSession });
    expect(sent.pop()).toMatchObject({ type: "device_bind_failed" });
    expect(devices.boundDevice(socket)).toBeUndefined();
    const sig = Buffer.from(sign(null, deviceBindDigest(connectorId, "1", nonce), keys.privateKey)).toString("hex");
    await devices.bind(socket, connectorId, "1", { device_id: deviceId, sig });
    expect(sent.pop()).toEqual({ type: "device_bound", device_id: deviceId });
    expect(devices.boundDevice(socket)).toBe(deviceId);

    await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [connectorId]);
    const later = fakeSocket();
    const laterNonce = Buffer.from(devices.welcome(later.socket, ["next_device_v1"]).device_nonce!, "hex");
    await devices.bind(later.socket, connectorId, "1", { device_id: deviceId, sig: Buffer.from(sign(null, deviceBindDigest(connectorId, "1", laterNonce), keys.privateKey)).toString("hex") });
    expect(later.sent.pop()).toMatchObject({ type: "device_bind_failed" });
  });

  it("adds Noise fields to the lease snapshot only for next_device_v1 connectors", async () => {
    const connectorId = await revocationFixture(db);
    await db.query("UPDATE grants SET activated_at = now(), operations = $2, application_authorization = jsonb_set(application_authorization, '{binding,contracts,semantic_capabilities}', '2') WHERE id = $1",
      [connectorId, JSON.stringify(["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type"])]);
    await db.query("UPDATE applications SET application_declaration = '{}'::jsonb WHERE id = $1", [connectorId]);
    const clientPk = randomBytes(32);
    await db.query("INSERT INTO next_grant_client_keys (grant_id, client_pk) VALUES ($1, $2)", [connectorId, clientPk]);

    const plain = await buildPolicySnapshot(db, connectorId, 55_000, undefined, () => true, "lease_v1", true, false) as LeasePolicySnapshot;
    expect(plain.grants[0]).not.toHaveProperty("client_pk");
    expect(plain.grants[0]).not.toHaveProperty("capabilities");

    const next = await buildPolicySnapshot(db, connectorId, 55_000, undefined, () => true, "lease_v1", true, true) as LeasePolicySnapshot;
    expect(next.grants[0]).toMatchObject({
      id: connectorId,
      capabilities: ["collection.read"],
      client_pk: clientPk.toString("hex"),
      client_fingerprint: clientFingerprint(clientPk)
    });
    expect(next.sequence).toBeGreaterThan(plain.sequence);
  });
});
