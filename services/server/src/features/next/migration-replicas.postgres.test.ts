import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { HostedProviderResponseError, type HostedProviderClient, type LegacyMigrationRollbackReceipt,
  type LegacyMigrationRollbackRequest } from "../../hosted-provider.js";
import { registerMigrationReplicaRoutes } from "./migration-replicas.js";
import { PolicyEmitter, registerNextCollection } from "./policy-outbox.js";
import { LogServiceClient } from "./log-service-client.js";
import { decodeCbor, type PolicySigner } from "./policy-wire.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { FakeLogService, certify, field, bytes } from "../../../test/policy-log.js";
import { accountUpgradeRolledBack } from "./migration-rollback-state.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const token = "synthetic-migration-token-".repeat(2);
const sorted = (ids: string[]) => [...ids].sort();

interface Source { state: string; run: string | null; storageOwner: string; replicas: Map<string, string | null>; inFlight: number }

suite("migration replica, unfence and cutover-policy fronts (isolated real PostgreSQL, synthetic provider)", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `migration_replicas_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 }); await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`); db = await createDatabase(url.toString());
  }, 60000);
  afterAll(async () => { await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end(); });

  async function account() {
    const id = randomUUID(), cohort = `c-${randomUUID().slice(0, 8)}`;
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Test')", [id, `${id}@example.test`]);
    await db.query("INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)", [id, randomUUID()]);
    await db.query("INSERT INTO next_migration_cohorts(name,released_at,frozen_at) VALUES($1,now(),now())", [cohort]);
    await db.query("INSERT INTO next_migration_cohort_members(account_id,cohort,started_at) VALUES($1,$2,now())", [id, cohort]);
    return id;
  }
  async function collection(owner: string, sources: Map<string, Source>) {
    const id = randomUUID();
    await db.query("INSERT INTO hosted_collections(id,user_id,display_name,template) VALUES($1,$2,'Source','mdbase')", [id, owner]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'shadow','cloud_copy',$3)", [id, owner, Buffer.alloc(16, 7)]);
    const replicas = new Map<string, string | null>([[randomUUID(), null], [randomUUID(), null]]);
    const storage = (await db.query<{ provider_account_id: string }>("SELECT provider_account_id::text FROM account_storage_accounts WHERE user_id=$1", [owner])).rows[0]!;
    expect(storage.provider_account_id).not.toBe(owner);
    sources.set(id, { state: "migrating", run: randomUUID(), storageOwner: storage.provider_account_id, replicas, inFlight: 0 });
    return id;
  }

  async function signedEmitter(collectionId: string, ownerUserId: string) {
    const root = generateKeyPairSync("ed25519").privateKey, policy = generateKeyPairSync("ed25519").privateKey;
    const issuer = generateKeyPairSync("ed25519").privateKey, transport = generateKeyPairSync("ed25519").privateKey;
    const signer: PolicySigner = certify(root, policy, Date.now());
    const service = new FakeLogService(ed25519RawPublicKey(issuer));
    const pem = (key: typeof issuer) => key.export({ format: "pem", type: "pkcs8" }).toString();
    const log = new LogServiceClient({ url: "http://log.test", tokenIssuerKeyPem: pem(issuer), transportKeyPem: pem(transport) }, service.fetch);
    const emitter = new PolicyEmitter(db, log, signer);
    // Replace this fixture's empty placeholder with the real durable genesis.
    await db.query("DELETE FROM next_collections WHERE collection_id=$1", [collectionId]);
    await registerNextCollection(db, { collectionId, ownerUserId, runtime: "shadow", sync: "cloud_copy", rootKeyId: signer.cert.root,
      ops: [{ op: "genesis", owner: ownerUserId, root: signer.cert.root, state: "cloud-copy" }, { op: "member-set", account: ownerUserId, role: "owner" }] });
    expect(await emitter.drainCollection(collectionId)).toBe(1);
    return { emitter, log, service, signer };
  }

  async function fixture(signed = false) {
    const sources = new Map<string, Source>(), effects: string[] = [];
    const receipts = new Map<string, LegacyMigrationRollbackReceipt>();
    let head = 10, providerEpoch = 1, tamper: ((r: LegacyMigrationRollbackReceipt) => LegacyMigrationRollbackReceipt) | null = null;
    const owner = await account(), a = await collection(owner, sources), b = await collection(owner, sources);
    const src = (id: string) => sources.get(id)!;
    const owned = (id: string) => sorted([...src(id).replicas].filter(([, by]) => by !== null && by === src(id).run).map(([r]) => r));
    const fenced = (id: string) => { if (src(id).state !== "migrating") throw new HostedProviderResponseError(409, "legacy_migration_not_started", "x"); };
    const provider: Pick<HostedProviderClient, "legacyMigrationDrain" | "legacyMigrationReplicas" | "legacyMigrationRevokeReplicas"
      | "legacyMigrationRestoreReplicas" | "legacyMigrationRevokedReplicas" | "legacyMigrationUnfence"
      | "legacyMigrationRollback" | "legacyMigrationRollbackReceipt"> = {
      async legacyMigrationDrain(id) {
        const s = src(id);
        return { collection_id: id, state: s.state, migration_id: s.run, head: 42, started_at: s.run ? "2026-10-12T00:00:00.000Z" : null,
          retain_until: null, in_flight: s.inFlight, unresolved: 0, applied_unreceipted: 0 };
      },
      async legacyMigrationReplicas(id) {
        return { replicas: [...src(id).replicas].filter(([, by]) => by === null).map(([r]) => ({ id: r, head: 42, acknowledged_sequence: 42,
          last_seen_at: null, token_expires_at: "2026-11-01T00:00:00.000Z" })) };
      },
      // Provider scoping: only this collection's replicas, owned by the current run.
      async legacyMigrationRevokeReplicas(id, replicas) {
        effects.push(`revoke:${id}`); fenced(id);
        for (const r of replicas) if (src(id).replicas.get(r) === null) src(id).replicas.set(r, src(id).run);
        return { revoked: owned(id).filter(r => replicas.includes(r)) };
      },
      async legacyMigrationRestoreReplicas(id, replicas) {
        effects.push(`restore:${id}`); fenced(id);
        const restored = owned(id).filter(r => replicas.includes(r));
        for (const r of restored) src(id).replicas.set(r, null);
        return { restored };
      },
      async legacyMigrationRevokedReplicas(id) { fenced(id); return { collection_id: id, migration_id: src(id).run!, revoked: owned(id) }; },
      async legacyMigrationUnfence(id) {
        effects.push(`unfence:${id}`); Object.assign(src(id), { state: "active", run: null });
        return { collection_id: id, state: "active", migration_id: null, started_at: null, retain_until: null, restored: [] };
      },
      // Provider semantics: owner + its own epoch, one receipt per run, exact binding on replay/read.
      async legacyMigrationRollback(id, envelope) {
        if (envelope.provider_account_id !== src(id).storageOwner) conflict();
        const { binding } = envelope;
        effects.push(`rollback:${id}`);
        const existing = receipt(id, binding); if (existing) return existing;
        const s = src(id);
        if (s.state !== "migrating" || s.run !== binding.provider_migration_id || binding.fixed_head !== 42) conflict();
        const restored = owned(id).filter(r => binding.replica_ids.includes(r));
        for (const r of restored) s.replicas.set(r, null);
        Object.assign(s, { state: "active", run: null });
        const made = { collection_id: id, binding: { ...binding }, restored_ids: restored, recorded_at: new Date().toISOString() };
        receipts.set(`${id}:${binding.provider_migration_id}`, made);
        return tamper ? tamper(structuredClone(made)) : made;
      },
      async legacyMigrationRollbackReceipt(id, envelope) {
        if (envelope.provider_account_id !== src(id).storageOwner) conflict();
        const { binding } = envelope;
        effects.push(`receipt:${id}`);
        const found = receipt(id, binding);
        if (!found) throw new HostedProviderResponseError(404, "legacy_rollback_receipt_unknown", "x");
        return tamper ? tamper(structuredClone(found)) : found;
      }
    };
    function conflict(): never { throw new HostedProviderResponseError(409, "legacy_rollback_binding_conflict", "x"); }
    function receipt(id: string, binding: LegacyMigrationRollbackRequest) {
      if (binding.authority_epoch !== providerEpoch) conflict();
      const found = receipts.get(`${id}:${binding.provider_migration_id}`);
      if (found && JSON.stringify(found.binding) !== JSON.stringify(binding)) conflict();
      return found;
    }
    const real = signed ? await signedEmitter(a, owner) : null;
    const app = Fastify();
    if (real) app.addHook("onClose", async () => real.emitter.close());
    registerMigrationReplicaRoutes(app, { db, token, provider, log: real?.log ?? { head: async () => ({ seq: head, chain: new Uint8Array(32) }) },
      emitter: real?.emitter ?? { drainCollection: async () => 0 } });
    const claim = (await db.query<{ started_us: string }>(
      "SELECT (extract(epoch FROM started_at)*1000000)::bigint::text AS started_us FROM next_migration_cohort_members WHERE account_id=$1", [owner])).rows[0]!;
    const binding = (id = a) => ({ owner_account: owner, started_us: claim.started_us, migration_id: src(id).run });
    const driver = randomUUID(), action = randomUUID();
    const call = (kind: string, body: Record<string, unknown>, id = a) => app.inject({ method: "POST",
      url: `/internal/v1/next/migration/collections/${id}/${kind}`, headers: { authorization: `Bearer ${token}` }, payload: body });
    const replicas = (id = a) => sorted([...src(id).replicas.keys()]);
    const cutovers = async (id = a) => (await db.query<{ ops: { ops: unknown[] } }>(
      `SELECT ops FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> '[{"op":"migration-cutover"}]'::jsonb`, [id])).rows;
    const rollbackBody = (id = a, extra: Record<string, unknown> = {}) => ({ ...binding(id), fixed_head: 42,
      driver_id: driver, action_id: action, replica_ids: replicas(id), ...extra });
    const events = async (type: string, id = a) => (await db.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE event_type=$1 AND subject_id=$2 ORDER BY id", [type, id])).rows.map(r => r.metadata);
    return { owner, a, b, src, app, call, binding, replicas, cutovers, effects, rollbackBody, events, real,
      abortBody: () => ({ ...binding(), driver_id: driver, action_id: action, run_sequence: 1, action_sequence: 186,
        fingerprint: "37".repeat(32), checkpoint_digest: "48".repeat(32) }),
      set head(v: number) { head = v; }, set providerEpoch(v: number) { providerEpoch = v; }, set tamper(v: typeof tamper) { tamper = v; } };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  const revokeAll = async (f: F, id = f.a) => {
    const r = await f.call("replicas/revoke", { ...f.binding(id), replica_ids: f.replicas(id) }, id);
    expect(r.statusCode, r.body).toBe(200); return r;
  };
  const cutover = (f: F, revoked: string[], id = f.a) => f.call("cutover-policy", { ...f.binding(id), revoked, base_seq: 10 }, id);

  it("authenticates both barrier routes and rejects caller proof/force or malformed tuples without intent", async () => {
    const f = await fixture(); try {
      const input = f.abortBody();
      const malformed: Array<Record<string, unknown>> = [
        { source: {} }, { barrier: {} }, { outcome: "aborted" }, { force: true },
        { owner_account: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
        { driver_id: "00000000-0000-0000-0000-000000000000" },
        { started_us: input.started_us + "\n" }, { run_sequence: 1.5 },
        { action_sequence: 0 }, { action_sequence: Number.MAX_SAFE_INTEGER + 1 },
        { fingerprint: input.fingerprint + "\n" }, { checkpoint_digest: "ff" }
      ];
      for (const kind of ["appendbase-abort-barrier", "appendbase-abort-barrier-receipt"]) {
        for (const headers of [{}, { authorization: "Bearer wrong-token" }]) {
          const response = await f.app.inject({ method: "POST", headers, payload: input,
            url: `/internal/v1/next/migration/collections/${f.a}/${kind}` });
          expect(response.statusCode, response.body).toBe(401);
          expect(response.headers["cache-control"]).toBe("no-store");
        }
        for (const extra of malformed) {
          const response = await f.call(kind, { ...input, ...extra });
          expect(response.statusCode, response.body).toBe(400);
        }
      }
      expect(await f.events("next_migration.appendbase_abort_barrier")).toEqual([]);
      expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1", [f.a])).rowCount).toBe(0);
      expect(f.effects).toEqual([]);
    } finally { await f.app.close(); }
  });

  it("retains exact signed barrier bytes across committed-append/lost-response; lookup cannot emit", async () => {
    const f = await fixture(true); try {
      const input = f.abortBody(), real = f.real!;
      real.service.dropNextResponse = "append";
      const first = await f.call("appendbase-abort-barrier", input);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ state: "queued", sequence: null, item_sha256: null });
      const batches = async () => (await db.query<{ id: string; seq: string; item: Buffer; state: string }>(
        "SELECT id,seq,item,state FROM next_policy_batches WHERE collection_id=$1 AND seq>1 ORDER BY id", [f.a])).rows;
      const [original] = await batches(); expect(original!.state).toBe("sending");
      const retained = real.service.logs.get(f.a.replaceAll("-", ""))!;
      expect(retained).toHaveLength(2);
      expect(original!.item).toEqual(retained[1]);
      const lookup = await f.call("appendbase-abort-barrier-receipt", input);
      expect(lookup.statusCode, lookup.body).toBe(200); expect(lookup.json()).toEqual(first.json());
      expect((await batches())[0]!.state).toBe("sending");
      expect(retained).toHaveLength(2);
      const retry = await f.call("appendbase-abort-barrier", input);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ ...first.json(), state: "appended", sequence: 2,
        item_sha256: createHash("sha256").update(original!.item).digest("hex") });
      expect(await batches()).toEqual([{ ...original!, state: "appended" }]);
      expect(retained).toHaveLength(2);
      // Real signer/certificate and exact existing wire op; no cutover, grants,
      // membership, epoch, keys or positive Base evidence is manufactured.
      expect(real.service.policyOps(f.a, real.signer.cert.policyPublicKey)).toEqual([["1", "4"], ["11"]]);
      const payload = decodeCbor(bytes(field(decodeCbor(retained[1]!), 11)));
      const [freeze] = field(payload, 3) as unknown[];
      expect(field(freeze as never, 1)).toBe(true);
      expect(field(freeze as never, 2)).toBe(first.json().digest);
      expect(await f.events("next_migration.appendbase_abort_barrier")).toEqual([{ digest: first.json().digest, binding: input }]);
      expect(f.effects).toEqual([]);
    } finally { await f.app.close(); }
  });

  it.each(["in-flight", "next", "left"])("refuses changed qualification across the real signed append await: %s", async mode => {
    const f = await fixture(true); try {
      f.real!.service.beforeAppend = async () => {
        if (mode === "in-flight") f.src(f.a).inFlight = 1;
        if (mode === "next") await db.query("UPDATE next_collections SET runtime='next' WHERE collection_id=$1", [f.a]);
        if (mode === "left") await db.query("UPDATE next_collections SET left_sync_at=now() WHERE collection_id=$1", [f.a]);
      };
      const response = await f.call("appendbase-abort-barrier", f.abortBody());
      expect(response.statusCode, response.body).toBe(409);
      expect(await f.events("next_migration.appendbase_abort_barrier")).toHaveLength(1);
      expect(f.effects).toEqual([]);
    } finally { await f.app.close(); }
  });

  it("queues only one correlated negative freeze; receipt lookup cannot create or requeue", async () => {
    const f = await fixture(); try {
      const input = f.abortBody();
      const missing = await f.call("appendbase-abort-barrier-receipt", input);
      expect(missing.statusCode, missing.body).toBe(404);
      expect(await f.events("next_migration.appendbase_abort_barrier")).toHaveLength(0);
      const first = await f.call("appendbase-abort-barrier", input);
      expect(first.statusCode, first.body).toBe(200);
      const result = first.json();
      expect(result).toEqual({ schema: "mdbase-appendbase-abort-barrier/1", collection_id: f.a,
        driver_id: input.driver_id, action_id: input.action_id, digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        state: "queued", sequence: null, item_sha256: null });
      for (const kind of ["appendbase-abort-barrier", "appendbase-abort-barrier-receipt"]) {
        const retry = await f.call(kind, input); expect(retry.statusCode, retry.body).toBe(200);
        expect(retry.json()).toEqual(result);
      }
      const rows = (await db.query<{ ops: { ops: unknown[] } }>("SELECT ops FROM next_policy_outbox WHERE collection_id=$1", [f.a])).rows;
      expect(rows.map(row => row.ops.ops)).toEqual([[{ op: "freeze", frozen: true, reason: result.digest }]]);
      expect(await f.events("next_migration.appendbase_abort_barrier")).toEqual([{ digest: result.digest, binding: input }]);
      expect(f.effects).toEqual([]);
    } finally { await f.app.close(); }
  });

  it("serializes concurrent barrier creation and rejects changed full-tuple retries", async () => {
    const f = await fixture(); try {
      const input = f.abortBody();
      const replies = await Promise.all(Array.from({ length: 4 }, () => f.call("appendbase-abort-barrier", input)));
      for (const reply of replies) expect([200, 503], reply.body).toContain(reply.statusCode);
      expect(replies.some(r => r.statusCode === 200)).toBe(true);
      for (const changes of [{ fingerprint: "59".repeat(32) }, { checkpoint_digest: "6a".repeat(32) },
        { action_sequence: 187 }, { run_sequence: 2 }]) {
        const response = await f.call("appendbase-abort-barrier", { ...input, ...changes });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().error.code).toBe("migration_abort_binding_conflict");
      }
      expect(await f.events("next_migration.appendbase_abort_barrier")).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1", [f.a])).rowCount).toBe(1);
    } finally { await f.app.close(); }
  });

  it.each(["in-flight", "active", "foreign-run", "next", "queued-cutover"])("refuses an ineligible barrier without creating an intent: %s", async mode => {
    const f = await fixture(); try {
      const input = f.abortBody();
      if (mode === "in-flight") f.src(f.a).inFlight = 1;
      if (mode === "active") f.src(f.a).state = "active";
      if (mode === "foreign-run") f.src(f.a).run = randomUUID();
      if (mode === "next") await db.query("UPDATE next_collections SET runtime='next' WHERE collection_id=$1", [f.a]);
      if (mode === "queued-cutover") {
        await revokeAll(f); const response = await cutover(f, f.replicas()); expect(response.statusCode, response.body).toBe(200);
      }
      const response = await f.call("appendbase-abort-barrier", input);
      expect(response.statusCode, response.body).toBe(409);
      expect(await f.events("next_migration.appendbase_abort_barrier")).toHaveLength(0);
      expect((await db.query("SELECT 1 FROM next_policy_outbox WHERE collection_id=$1 AND ops->'ops' @> '[{\"op\":\"freeze\",\"frozen\":true}]'::jsonb", [f.a])).rowCount).toBe(0);
    } finally { await f.app.close(); }
  });

  it("lists, revokes and queues exactly one cutover policy; a repeat finds it", async () => {
    const f = await fixture(); try {
      const listed = await f.call("replicas", f.binding()); expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().replicas.map((r: { id: string }) => r.id).sort()).toEqual(f.replicas());
      expect(Object.keys(listed.json().replicas[0]).sort()).toEqual(["acknowledged_sequence", "head", "id", "last_seen_at", "token_expires_at"]);
      expect((await revokeAll(f)).json()).toEqual({ revoked: f.replicas() });
      const first = await cutover(f, f.replicas()); expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ collection_id: f.a, revoked: f.replicas(), freeze: false, created: true });
      const again = await cutover(f, f.replicas()); expect(again.statusCode, again.body).toBe(200);
      expect(again.json().created).toBe(false);
      const rows = await f.cutovers(); expect(rows).toHaveLength(1);
      expect(rows[0]!.ops.ops).toEqual([
        { op: "migration-cutover", legacyCollection: f.a, revoked: f.replicas(), cutoverAt: expect.any(Number) },
        { op: "freeze", frozen: false }]);
      // A different set after queueing is a conflict, never a second item.
      expect((await cutover(f, f.replicas().slice(1))).json().error.code).toBe("migration_cutover_conflict");
      expect(await f.cutovers()).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it("queues one cutover under concurrent requests", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const results = await Promise.all(Array.from({ length: 4 }, () => cutover(f, f.replicas())));
      for (const r of results) expect([200, 503], r.body).toContain(r.statusCode);
      expect(results.filter(r => r.statusCode === 200 && r.json().created)).toHaveLength(1);
      expect(await f.cutovers()).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it.each(["subset", "superset", "empty", "foreign"])("refuses a cutover whose revoked set is not the run's: %s", async mode => {
    const f = await fixture(); try {
      const [r0, r1] = f.replicas();
      // The run owns both for "subset", otherwise only r0.
      await f.call("replicas/revoke", { ...f.binding(), replica_ids: mode === "subset" ? [r0, r1] : [r0] });
      const set = { subset: [r0!], superset: [r0!, r1!], empty: [], foreign: sorted([r0!, f.replicas(f.b)[0]!]) }[mode]!;
      const r = await cutover(f, set);
      expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe("migration_revoked_set_mismatch");
      expect(await f.cutovers()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it("refuses a cutover before the base is in the log", async () => {
    const f = await fixture(); try {
      await revokeAll(f); f.head = 9;
      const r = await cutover(f, f.replicas()); expect(r.json().error.code).toBe("migration_base_not_logged");
      expect(await f.cutovers()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it.each(["replicas", "replicas/revoke", "replicas/unrevoke", "unfence", "cutover-policy"])("refuses stale or foreign claims before any effect: %s", async kind => {
    const f = await fixture(); try {
      const foreign = await account();
      const extra = kind.startsWith("replicas/") ? { replica_ids: f.replicas() } : kind === "cutover-policy" ? { revoked: [], base_seq: 10 } : {};
      const stale = { ...f.binding(), started_us: String(BigInt(f.binding().started_us) - 1n) };
      for (const body of [stale, { ...f.binding(), owner_account: foreign }]) {
        const r = await f.call(kind, { ...body, ...extra }); expect(r.statusCode, r.body).toBe(409);
        expect(r.json().error.code).toBe("migration_claim_not_current");
      }
      expect((await f.call(kind, { ...f.binding(), migration_id: randomUUID(), ...extra })).json().error.code).toBe("migration_run_not_current");
      expect(f.effects).toEqual([]); expect(await f.cutovers()).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it.each(["restart", "connect-cutover", "backend-flip"])("refuses a revoke or unrevoke replayed after the claim moved on: %s", async change => {
    const f = await fixture(); try {
      const revoke = { ...f.binding(), replica_ids: f.replicas() };
      await revokeAll(f);
      const unrevoke = await f.call("replicas/unrevoke", revoke); expect(unrevoke.statusCode, unrevoke.body).toBe(200);
      if (change === "restart") await db.query("UPDATE next_migration_cohort_members SET started_at=started_at+interval '1 second' WHERE account_id=$1", [f.owner]);
      if (change === "connect-cutover") await db.query("INSERT INTO next_migration_collections(collection_id,account_id,s_final,cutover_seq,barrier_f,final_digest) VALUES($1,$2,42,11,11,$3)", [f.a, f.owner, "ab".repeat(32)]);
      if (change === "backend-flip") await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [f.owner]);
      const effects = f.effects.length;
      for (const kind of ["replicas/revoke", "replicas/unrevoke"]) {
        const r = await f.call(kind, revoke); expect(r.statusCode, r.body).toBe(409);
      }
      expect(f.effects).toHaveLength(effects);
    } finally { await f.app.close(); }
  });

  it("unfences only a fenced, uncut run that owns no revocation", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const blocked = await f.call("unfence", f.binding()); expect(blocked.json().error.code).toBe("migration_replicas_revoked");
      expect((await f.call("replicas/unrevoke", { ...f.binding(), replica_ids: f.replicas() })).json()).toEqual({ restored: f.replicas() });
      const binding = f.binding();
      const done = await f.call("unfence", binding); expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ state: "active", migration_id: null });
      // Replayed unfence: the run is gone.
      const replay = await f.call("unfence", binding); expect(replay.json().error.code).toBe("migration_run_not_current");
      expect(f.effects.filter(e => e.startsWith("unfence"))).toHaveLength(1);
    } finally { await f.app.close(); }
  });

  it("refuses every rollback step once the cutover policy is queued", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      expect((await cutover(f, f.replicas())).statusCode).toBe(200);
      const effects = f.effects.length;
      for (const kind of ["replicas/revoke", "replicas/unrevoke", "unfence"]) {
        const r = await f.call(kind, { ...f.binding(), ...(kind === "unfence" ? {} : { replica_ids: f.replicas() }) });
        expect(r.statusCode, r.body).toBe(409); expect(r.json().error.code).toBe("migration_cutover_queued");
      }
      expect(f.effects).toHaveLength(effects);
    } finally { await f.app.close(); }
  });

  it("binds each collection to its own run: no cross-collection use", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      // Same owner, so only the provider run tells the collections apart.
      const crossRun = await f.call("cutover-policy", { ...f.binding(f.a), revoked: f.replicas(), base_seq: 10 }, f.b);
      expect(crossRun.json().error.code).toBe("migration_run_not_current");
      const crossSet = await cutover(f, f.replicas(f.a), f.b);
      expect(crossSet.json().error.code).toBe("migration_revoked_set_mismatch");
      const crossRevoke = await f.call("replicas/revoke", { ...f.binding(f.a), replica_ids: f.replicas(f.b) });
      expect(crossRevoke.json()).toEqual({ revoked: [] });
      expect([...f.src(f.b).replicas.values()]).toEqual([null, null]);
      expect(await f.cutovers(f.b)).toHaveLength(0);
    } finally { await f.app.close(); }
  });

  it("refuses ordinary credentials and non-canonical bodies", async () => {
    const f = await fixture(); try {
      const wrong = await f.app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.a}/replicas`,
        headers: { authorization: "Bearer session" }, payload: f.binding() });
      expect(wrong.statusCode).toBe(401);
      for (const body of [{ ...f.binding(), replica_ids: [...f.replicas()].reverse() }, { ...f.binding(), replica_ids: [] },
        { ...f.binding(), replica_ids: f.replicas(), extra: 1 }]) {
        expect((await f.call("replicas/revoke", body)).statusCode).toBe(400);
      }
      expect((await f.call("cutover-policy", { ...f.binding(), revoked: [], base_seq: 0 })).statusCode).toBe(400);
      expect(f.effects).toEqual([]);
    } finally { await f.app.close(); }
  });
  it("rolls back through Connect with a receipt echoing the exact binding; replays and reads are idempotent", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const body = f.rollbackBody(), expected = {
        owner_account_id: f.owner, provider_migration_id: body.migration_id, authority_epoch: 1, fixed_head: 42,
        driver_id: body.driver_id, action_id: body.action_id, replica_ids: f.replicas() };
      expect(await accountUpgradeRolledBack(db, f.owner)).toBe(false);
      const done = await f.call("rollback", body); expect(done.statusCode, done.body).toBe(200);
      // The receipt makes the account's upgrade read as rolled back, while its
      // start claim stays (the receipt reads below still bind to it).
      expect(await accountUpgradeRolledBack(db, f.owner)).toBe(true);
      expect((await db.query("SELECT started_at FROM next_migration_cohort_members WHERE account_id=$1", [f.owner])).rows[0].started_at).not.toBeNull();
      expect(done.json()).toEqual({ collection_id: f.a, binding: expected, restored_ids: f.replicas(), recorded_at: expect.any(String) });
      expect(f.src(f.a)).toMatchObject({ state: "active", run: null });
      // Re-reads with or without the original receipt's epoch return it unchanged.
      for (const [kind, extra] of [["rollback-receipt", {}], ["rollback-receipt", { authority_epoch: 1 }], ["rollback", {}],
        ["rollback", { authority_epoch: 1 }]] as const) {
        const again = await f.call(kind, { ...body, ...extra }); expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toEqual(done.json());
      }
      for (const kind of ["rollback", "rollback-receipt"]) {
        expect((await f.call(kind, { ...body, authority_epoch: 2 })).json().error.code).toBe("migration_rollback_binding_conflict");
      }
      expect(await f.events("next_migration.rollback_intent")).toEqual([{ migration_id: body.migration_id, binding: expected }]);
      expect(await f.events("next_migration.rollback")).toEqual([{ migration_id: body.migration_id, binding: expected,
        restored_ids: f.replicas(), recorded_at: done.json().recorded_at }]);
      // A lost reply is settled by the receipt read alone.
      await revokeAll(f, f.b);
      f.tamper = () => { throw new HostedProviderResponseError(502, "invalid_provider_response", "lost"); };
      const lostBody = f.rollbackBody(f.b), lost = await f.call("rollback", lostBody, f.b);
      expect(lost.statusCode).toBe(503);
      f.tamper = null;
      const settled = await f.call("rollback-receipt", lostBody, f.b);
      expect(settled.statusCode, settled.body).toBe(200); expect(settled.json().restored_ids).toEqual(f.replicas(f.b));
      // A later fence of each rolled-back collection (an operator restart) means it is migrating again.
      for (const id of [f.a, f.b]) {
        expect(await accountUpgradeRolledBack(db, f.owner)).toBe(true);
        await db.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata,created_at) VALUES($1,$2,'next_migration.fence',$3,'{}',now()+interval '1 second')",
          [randomUUID(), f.owner, id]);
      }
      expect(await accountUpgradeRolledBack(db, f.owner)).toBe(false);
    } finally { await f.app.close(); }
  });

  it("refuses a wrong claim, epoch, run or scope before any rollback effect", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const foreign = await account(), stale = String(BigInt(f.binding().started_us) - 1n);
      const refusals: Array<[Record<string, unknown>, string]> = [
        [{ started_us: stale }, "migration_claim_not_current"], [{ owner_account: foreign }, "migration_claim_not_current"],
        [{ migration_id: randomUUID() }, "migration_run_not_current"],
        [{ replica_ids: f.replicas().slice(1) }, "migration_revoked_set_mismatch"]];
      for (const [change, code] of refusals) {
        const r = await f.call("rollback", f.rollbackBody(f.a, change)); expect(r.statusCode, r.body).toBe(409);
        expect(r.json().error.code).toBe(code);
      }
      // An epoch is never authority for a fresh rollback, nor names a receipt that does not exist.
      for (const kind of ["rollback-receipt", "rollback"]) {
        for (const extra of kind === "rollback" ? [{ authority_epoch: 1 }] : [{}, { authority_epoch: 1 }]) {
          const unknown = await f.call(kind, f.rollbackBody(f.a, extra)); expect(unknown.statusCode, unknown.body).toBe(404);
          expect(unknown.json().error.code).toBe("migration_rollback_unknown");
        }
      }
      const wrong = await f.app.inject({ method: "POST", url: `/internal/v1/next/migration/collections/${f.a}/rollback`,
        headers: { authorization: "Bearer session" }, payload: f.rollbackBody() });
      expect(wrong.statusCode).toBe(401);
      for (const extra of [{ replica_ids: [...f.replicas()].reverse() }, { authority_epoch: 0 }, { authority_epoch: "1" }, { fixed_head: -1 }, { driver_id: "x" }, { extra: 1 }]) {
        expect((await f.call("rollback", f.rollbackBody(f.a, extra))).statusCode).toBe(400);
      }
      expect(f.effects.filter(e => !e.startsWith("revoke"))).toEqual([]);
      expect(await f.events("next_migration.rollback_intent")).toEqual([]);
      expect((await cutover(f, f.replicas())).statusCode).toBe(200);
      expect((await f.call("rollback", f.rollbackBody())).json().error.code).toBe("migration_cutover_queued");
      expect(f.src(f.a).state).toBe("migrating");
    } finally { await f.app.close(); }
  });

  it.each(["driver_id", "action_id", "fixed_head", "replica_ids", "authority_epoch", "migration_id"])(
    "refuses a replay or receipt read whose binding differs from the recorded one: %s", async field => {
    const f = await fixture(); try {
      await revokeAll(f);
      const body = f.rollbackBody();
      expect((await f.call("rollback", body)).statusCode).toBe(200);
      // The epoch is never presented: it moves under the recorded binding instead.
      if (field === "authority_epoch") await db.query("UPDATE hosted_collections SET authority_epoch=2 WHERE id=$1", [f.a]);
      const changed = field === "authority_epoch" ? body : { ...body, [field]: { driver_id: randomUUID(), action_id: randomUUID(), fixed_head: 41,
        replica_ids: f.replicas().slice(1), migration_id: randomUUID() }[field] };
      const effects = f.effects.length;
      for (const kind of ["rollback", "rollback-receipt"]) {
        const r = await f.call(kind, changed);
        const code = field === "authority_epoch" ? "migration_epoch_not_current" : field !== "migration_id" ? "migration_rollback_binding_conflict"
          : kind === "rollback" ? "migration_run_not_current" : "migration_rollback_unknown";
        expect(r.json().error.code, `${kind} ${r.body}`).toBe(code);
      }
      expect(f.effects).toHaveLength(effects);
      expect(await f.events("next_migration.rollback_intent")).toHaveLength(1);
      if (field === "authority_epoch") await db.query("UPDATE hosted_collections SET authority_epoch=1 WHERE id=$1", [f.a]);
      expect((await f.call("rollback-receipt", body)).statusCode).toBe(200);
    } finally { await f.app.close(); }
  });

  it("uses the non-identity physical mapping without rewriting the original intent", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const body = f.rollbackBody(), original = { owner_account_id: f.owner, provider_migration_id: body.migration_id,
        authority_epoch: 1, fixed_head: body.fixed_head, driver_id: body.driver_id, action_id: body.action_id, replica_ids: body.replica_ids };
      await db.query("INSERT INTO audit_events(id,user_id,event_type,subject_id,metadata) VALUES($1,$2,'next_migration.rollback_intent',$3,$4)",
        [randomUUID(), f.owner, f.a, JSON.stringify({ migration_id: body.migration_id, binding: original })]);
      const before = await f.events("next_migration.rollback_intent");
      const done = await f.call("rollback", body);
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json().binding).toEqual(original);
      expect(f.src(f.a).storageOwner).not.toBe(f.owner);
      const physical = await f.events("next_migration.rollback_provider_binding");
      expect(physical).toEqual([{ migration_id: body.migration_id, binding: original, provider_account_id: f.src(f.a).storageOwner }]);
      const count = f.effects.length;
      await db.query("UPDATE account_storage_accounts SET provider_account_id=$2 WHERE user_id=$1", [f.owner, randomUUID()]);
      for (const kind of ["rollback", "rollback-receipt"]) {
        const changed = await f.call(kind, body);
        expect(changed.statusCode, changed.body).toBe(409);
        expect(changed.json().error.code).toBe("migration_rollback_binding_conflict");
      }
      expect(f.effects).toHaveLength(count);
      expect(await f.events("next_migration.rollback_intent")).toEqual(before);
      expect(await f.events("next_migration.rollback_provider_binding")).toEqual(physical);
      await db.query("UPDATE account_storage_accounts SET provider_account_id=$2 WHERE user_id=$1", [f.owner, f.src(f.a).storageOwner]);
      expect((await f.call("rollback-receipt", body)).json()).toEqual(done.json());
    } finally { await f.app.close(); }
  });

  it("refuses a missing mapping before recording an intent or calling the provider", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      await db.query("DELETE FROM account_storage_accounts WHERE user_id=$1", [f.owner]);
      const effects = f.effects.length;
      for (const kind of ["rollback", "rollback-receipt"]) {
        const response = await f.call(kind, f.rollbackBody());
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().error.code).toBe("migration_source_not_current");
      }
      expect(f.effects).toHaveLength(effects);
      expect(await f.events("next_migration.rollback_intent")).toEqual([]);
    } finally { await f.app.close(); }
  });

  it("pins an uncertain dispatch before any receipt and refuses a different physical target", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      f.providerEpoch = 2; // Provider refuses before making any receipt/effect.
      const body = f.rollbackBody(), first = await f.call("rollback", body);
      expect(first.json().error.code).toBe("migration_rollback_binding_conflict");
      expect(f.src(f.a).state).toBe("migrating");
      const intent = await f.events("next_migration.rollback_intent");
      const physical = await f.events("next_migration.rollback_provider_binding");
      expect(physical).toHaveLength(1);
      await db.query("UPDATE account_storage_accounts SET provider_account_id=$2 WHERE user_id=$1", [f.owner, randomUUID()]);
      const effects = f.effects.length;
      for (const kind of ["rollback", "rollback-receipt"]) {
        expect((await f.call(kind, body)).json().error.code).toBe("migration_rollback_binding_conflict");
      }
      expect(f.effects).toHaveLength(effects);
      expect(await f.events("next_migration.rollback_intent")).toEqual(intent);
      expect(await f.events("next_migration.rollback_provider_binding")).toEqual(physical);
    } finally { await f.app.close(); }
  });

  it("receipt-only lookup never creates a missing physical dispatch correlation", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const body = f.rollbackBody(), done = await f.call("rollback", body);
      expect(done.statusCode, done.body).toBe(200);
      // A predecessor intent may have no physical CP audit. The genuine
      // provider receipt still must qualify its own exact physical owner.
      await db.query("DELETE FROM audit_events WHERE event_type='next_migration.rollback_provider_binding' AND subject_id=$1", [f.a]);
      const before = await f.events("next_migration.rollback_intent");
      expect((await f.call("rollback-receipt", body)).json()).toEqual(done.json());
      expect(await f.events("next_migration.rollback_provider_binding")).toEqual([]);
      expect(await f.events("next_migration.rollback_intent")).toEqual(before);
    } finally { await f.app.close(); }
  });

  it("refuses a provider receipt that does not echo the binding", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      const tampers: Array<(r: LegacyMigrationRollbackReceipt) => LegacyMigrationRollbackReceipt> = [
        r => ({ ...r, collection_id: f.b }), r => ({ ...r, binding: { ...r.binding, driver_id: randomUUID() } }),
        r => ({ ...r, binding: { ...r.binding, replica_ids: [] } }), r => ({ ...r, restored_ids: [randomUUID()] })];
      const body = f.rollbackBody();
      for (const tamper of tampers) {
        f.tamper = tamper;
        const r = await f.call(tampers.indexOf(tamper) ? "rollback-receipt" : "rollback", body);
        expect(r.statusCode, r.body).toBe(503); expect(r.json().error.code).toBe("migration_source_unavailable");
      }
      expect(await f.events("next_migration.rollback")).toEqual([]);
      f.tamper = null;
      expect((await f.call("rollback-receipt", body)).statusCode).toBe(200);
      expect(await f.events("next_migration.rollback")).toHaveLength(1);
    } finally { await f.app.close(); }
  });
  it("derives the epoch from the collection's current provider binding, never from the caller", async () => {
    const f = await fixture(); try {
      await revokeAll(f);
      await db.query("UPDATE hosted_collections SET authority_epoch=5 WHERE id=$1", [f.a]); f.providerEpoch = 7;
      const body = f.rollbackBody();
      // Connect's binding is not the provider's: refused, nothing restored.
      const stale = await f.call("rollback", body); expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error.code).toBe("migration_rollback_binding_conflict");
      expect(f.src(f.a).state).toBe("migrating");
      await db.query("UPDATE hosted_collections SET authority_epoch=7 WHERE id=$1", [f.a]);
      // The recorded epoch-5 binding stays the run's binding until the epoch is 5 again.
      expect((await f.call("rollback", body)).json().error.code).toBe("migration_epoch_not_current");
      const g = await fixture(); try {
        await revokeAll(g);
        await db.query("UPDATE hosted_collections SET authority_epoch=7 WHERE id=$1", [g.a]); g.providerEpoch = 7;
        const done = await g.call("rollback", g.rollbackBody()); expect(done.statusCode, done.body).toBe(200);
        expect(done.json().binding.authority_epoch).toBe(7);
        expect((await g.call("rollback-receipt", g.rollbackBody(g.a, { migration_id: done.json().binding.provider_migration_id }))).json()).toEqual(done.json());
      } finally { await g.app.close(); }
    } finally { await f.app.close(); }
  });
});
