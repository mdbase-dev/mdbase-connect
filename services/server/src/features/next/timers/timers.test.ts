import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import { buildApp } from "../../../app.js";
import { createDatabase, type DatabasePool } from "../../../db.js";
import { HostedProviderClient } from "../../../hosted-provider.js";
import type { PushSubscriptionTarget, PushTransport } from "../../../notifications.js";
import { tokenHash } from "../../../security.js";
import {
  PushTargetSealer,
  sealExistingPushTargets,
  unsealPushTargets
} from "../push-target-seal.js";
import { legacyTimer } from "./hosted-copy.js";
import { timerEventId } from "./worker.js";

class RecordingPushTransport implements PushTransport {
  readonly deliveries: Array<{ target: PushSubscriptionTarget; payload: string }> = [];

  async send(target: PushSubscriptionTarget, payload: string): Promise<void> {
    this.deliveries.push({ target, payload });
  }
}

type Built = Awaited<ReturnType<typeof buildApp>>;
const resources: Array<{ app: Built["app"]; db: DatabasePool }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.db.end();
  }
});

const CRITERION = {
  id: "task.reminder",
  event: MDBASE_TIMER_FIRED_CONTRACT,
  presentation: { title: "Task reminder", body: "Open TaskNotes to view your task.", tag: "tasknotes-reminders" }
};
const TIMER_OPS = ["read", "list_timers", "put_timer", "cancel_timer", "reconcile_timers"];
const INTERNAL_TOKEN = "hosted_internal_token_012345678901234567890123";

async function fixture(options: {
  hosted?: boolean;
  operations?: string[];
  sealer?: PushTargetSealer;
} = {}) {
  const db = await createDatabase("memory");
  const transport = new RecordingPushTransport();
  const built = await buildApp({
    db,
    devAuth: true,
    publicUrl: "http://127.0.0.1:8787",
    hostedProvider: new HostedProviderClient({ url: "http://127.0.0.1:8790", internalToken: INTERNAL_TOKEN }),
    notifications: {
      publicKey: "public_vapid_key",
      transports: { webPush: transport },
      pollIntervalMs: 60_000,
      ...(options.sealer ? { pushTargetSealer: options.sealer } : {})
    },
    nextTimers: { pollIntervalMs: 60_000 }
  });
  resources.push({ app: built.app, db });
  const userId = randomUUID();
  const connectorId = randomUUID();
  const collectionId = randomUUID();
  const applicationId = randomUUID();
  const grantId = randomUUID();
  const applicationToken = `application_token_${randomUUID()}`;
  const connectorToken = `connector_token_${randomUUID()}`;
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [userId, `${userId}@example.test`, "User"]);
  await db.query(
    "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)",
    [connectorId, userId, "Computer", tokenHash(connectorToken)]
  );
  if (options.hosted) {
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template, provider_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [collectionId, userId, "Hosted Tasks", "blank", "http://127.0.0.1:8790"]
    );
  } else {
    await db.query(
      `INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, true)`,
      [collectionId, userId, connectorId, randomUUID(), "Tasks", "0.3.0"]
    );
  }
  await db.query(
    `INSERT INTO applications (id, canonical_identity, manifest_version, name, homepage, redirect_uris, notifications)
     VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      applicationId,
      `bundle:dev.tasknotes:sha256:${applicationId}`,
      "TaskNotes",
      "https://tasknotes.example/",
      JSON.stringify(["https://tasknotes.example/callback"]),
      JSON.stringify({ criteria: [CRITERION] })
    ]
  );
  await db.query(
    `INSERT INTO grants
       (id, user_id, application_id, ${options.hosted ? "hosted_collection_id" : "collection_id"},
        operations, scope, application_origin, notification_criteria,
        application_authorization, application_installation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb,
             '{"binding":{"protocol_version":4}}'::jsonb, $9)`,
    [
      grantId,
      userId,
      applicationId,
      collectionId,
      JSON.stringify(options.operations ?? TIMER_OPS),
      JSON.stringify({ contracts: [] }),
      "https://tasknotes.example",
      JSON.stringify([CRITERION]),
      randomUUID()
    ]
  );
  await db.query(
    "INSERT INTO access_tokens (id, token_hash, grant_id, expires_at) VALUES ($1, $2, $3, $4)",
    [randomUUID(), tokenHash(applicationToken), grantId, new Date(Date.now() + 600_000).toISOString()]
  );
  const auth = { authorization: `Bearer ${applicationToken}` };
  const base = `/v1/next/collections/${collectionId}/timers`;
  const call = (method: "GET" | "PUT" | "DELETE" | "POST", url: string, payload?: unknown) =>
    built.app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload }) });
  return { ...built, db, transport, grantId, collectionId, applicationToken, connectorToken, auth, base, call };
}

const future = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("timer service: put, cancel, reconcile", () => {
  it("keeps today's semantics for TaskNotes' reconcile", async () => {
    const f = await fixture();
    const timers = [
      { id: "a".repeat(64), fire_at: future(3_600_000) },
      { id: "b".repeat(64), fire_at: future(7_200_000) }
    ];
    const first = await f.call("POST", `${f.base}/task-reminders/reconcile`, { criterion_id: "task.reminder", timers });
    expect(first.statusCode).toBe(200);
    expect(first.json().namespace).toBe("task-reminders");
    expect(first.json().cancelled_ids).toEqual([]);
    expect(first.json().timers.map((t: { generation: number; status: string }) => [t.generation, t.status]))
      .toEqual([[1, "scheduled"], [1, "scheduled"]]);
    expect(first.json().timers[0]).not.toHaveProperty("data");

    // Same set: unchanged generations. One timer moved, one dropped.
    const same = await f.call("POST", `${f.base}/task-reminders/reconcile`, { criterion_id: "task.reminder", timers });
    expect(same.json().timers.map((t: { generation: number }) => t.generation)).toEqual([1, 1]);
    const moved = await f.call("POST", `${f.base}/task-reminders/reconcile`, {
      criterion_id: "task.reminder",
      timers: [{ id: "a".repeat(64), fire_at: future(1_800_000) }]
    });
    expect(moved.json().timers[0].generation).toBe(2);
    expect(moved.json().cancelled_ids).toEqual(["b".repeat(64)]);

    // An empty set cancels the namespace.
    const empty = await f.call("POST", `${f.base}/task-reminders/reconcile`, { criterion_id: "task.reminder", timers: [] });
    expect(empty.json().cancelled_ids).toEqual(["a".repeat(64)]);
    const listed = await f.call("GET", `${f.base}/task-reminders`);
    expect(listed.json().timers.map((t: { status: string }) => t.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("puts idempotently and cancels with a generation fence", async () => {
    const f = await fixture();
    const fireAt = future(60_000);
    const put = await f.call("PUT", `${f.base}/ns/t1`, { criterion_id: "task.reminder", fire_at: fireAt });
    expect(put.json()).toMatchObject({ id: "t1", generation: 1, status: "scheduled" });
    const again = await f.call("PUT", `${f.base}/ns/t1`, { criterion_id: "task.reminder", fire_at: fireAt });
    expect(again.json().generation).toBe(1);
    const stale = await f.call("DELETE", `${f.base}/ns/t1?generation=7`);
    expect(stale.json()).toEqual({ namespace: "ns", id: "t1", cancelled: false });
    const cancelled = await f.call("DELETE", `${f.base}/ns/t1?generation=1`);
    expect(cancelled.json().cancelled).toBe(true);
    const repeat = await f.call("DELETE", `${f.base}/ns/t1`);
    expect(repeat.json().cancelled).toBe(false);
    const rearmed = await f.call("PUT", `${f.base}/ns/t1`, { criterion_id: "task.reminder", fire_at: fireAt });
    expect(rearmed.json()).toMatchObject({ generation: 2, status: "scheduled" });
  });

  it("rejects bad input, other collections, missing operations and foreign criteria", async () => {
    const f = await fixture();
    const dup = await f.call("POST", `${f.base}/ns/reconcile`, {
      criterion_id: "task.reminder",
      timers: [{ id: "x", fire_at: future(1_000) }, { id: "x", fire_at: future(2_000) }]
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.details.reason).toBe("duplicate_timer_id");
    expect((await f.call("PUT", `${f.base}/bad:ns/t`, { criterion_id: "task.reminder", fire_at: future(1) })).statusCode).toBe(400);
    expect((await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: "tomorrow" })).statusCode).toBe(400);
    const other = await f.call("GET", `/v1/next/collections/${randomUUID()}/timers/ns`);
    expect(other.statusCode).toBe(403);
    const criterion = await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "other", fire_at: future(1) });
    expect(criterion.json().error.details.reason).toBe("timer_criterion_not_authorized");
    const unauthenticated = await f.app.inject({ method: "GET", url: `${f.base}/ns` });
    expect(unauthenticated.statusCode).toBe(401);

    const readOnly = await fixture({ operations: ["read", "list_timers"] });
    const denied = await readOnly.call("PUT", `${readOnly.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(1) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details.reason).toBe("missing_operation");
  });

  it("refuses timer data for local collections and keeps it for cloud copies", async () => {
    const local = await fixture();
    const refused = await local.call("PUT", `${local.base}/ns/t`, {
      criterion_id: "task.reminder", fire_at: future(1_000), data: { title: "secret" }
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.reason).toBe("timer_data_not_permitted");

    const hosted = await fixture({ hosted: true });
    const kept = await hosted.call("PUT", `${hosted.base}/ns/t`, {
      criterion_id: "task.reminder", fire_at: future(1_000), data: { n: 1 }
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().data).toEqual({ n: 1 });
  });

  it("serves the hosted shim for a named grant", async () => {
    const hosted = await fixture({ hosted: true });
    const shim = await hosted.app.inject({
      method: "POST",
      url: `/internal/v1/next/timers/${hosted.grantId}/ns/reconcile`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { criterion_id: "task.reminder", timers: [{ id: "t", fire_at: future(1_000) }] }
    });
    expect(shim.statusCode).toBe(200);
    const badShim = await hosted.app.inject({
      method: "GET", url: `/internal/v1/next/timers/${hosted.grantId}/ns`, headers: { authorization: "Bearer nope" }
    });
    expect(badShim.statusCode).toBe(401);

    const local = await fixture();
    const noDeviceRoute = await local.app.inject({
      method: "PUT",
      url: `/v1/next/devices/timers/${local.grantId}/ns/t`,
      headers: { authorization: `Bearer ${local.connectorToken}` },
      payload: { criterion_id: "task.reminder", fire_at: future(1_000) }
    });
    // The daemon route waits for device proof of possession (SEC-043 §3).
    expect(noDeviceRoute.statusCode).toBe(404);
  });
});

describe("security conditions before MDBASE_NEXT_TIMERS=1 (#598)", () => {
  async function markPrivate(f: Awaited<ReturnType<typeof fixture>>) {
    const owner = await f.db.query<{ user_id: string }>("SELECT user_id FROM grants WHERE id = $1", [f.grantId]);
    await f.db.query(
      `INSERT INTO next_collections (collection_id, owner_user_id, runtime, sync, root_key_id)
       VALUES ($1, $2, 'next', 'private', $3)`,
      [f.collectionId, owner.rows[0].user_id, Buffer.alloc(8)]
    );
  }

  it("fails closed for private-sync grants: no timers, no data, no firing", async () => {
    const f = await fixture({ hosted: true });
    await f.call("PUT", `${f.base}/ns/before`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    await markPrivate(f);
    const put = await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    expect(put.statusCode).toBe(403);
    expect(put.json().error.details.reason).toBe("grant_not_usable");
    const withData = await f.call("PUT", `${f.base}/ns/t`, {
      criterion_id: "task.reminder", fire_at: future(60_000), data: { a: 1 }
    });
    expect(withData.statusCode).toBe(403);
    // A timer written before the switch is cancelled at fire time, with no event.
    await f.db.query("UPDATE next_timers SET fire_at = $1", [new Date(Date.now() - 1_000).toISOString()]);
    await f.timers!.tick();
    expect((await f.db.query("SELECT event_id FROM next_timer_events")).rows).toHaveLength(0);
    const rows = await f.db.query<{ status: string }>("SELECT status FROM next_timers");
    expect(rows.rows[0].status).toBe("cancelled");
  });

  it("limits the provider's internal token to cloud-copy grants", async () => {
    const local = await fixture();
    const shim = (grantId: string, method: "GET" | "POST" | "DELETE", path: string, payload?: unknown) =>
      local.app.inject({
        method,
        url: `/internal/v1/next/timers/${grantId}/${path}`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        ...(payload === undefined ? {} : { payload })
      });
    for (const response of [
      await shim(local.grantId, "GET", "ns"),
      await shim(local.grantId, "POST", "ns/reconcile", { criterion_id: "task.reminder", timers: [] }),
      await shim(local.grantId, "DELETE", "ns/t"),
      await shim(randomUUID(), "GET", "ns")
    ]) {
      expect(response.statusCode).toBe(403);
    }

    const hosted = await fixture({ hosted: true });
    await markPrivate(hosted);
    const privateGrant = await hosted.app.inject({
      method: "GET",
      url: `/internal/v1/next/timers/${hosted.grantId}/ns`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` }
    });
    expect(privateGrant.statusCode).toBe(403);

    const imported = await local.app.inject({
      method: "POST",
      url: "/internal/v1/next/timers/import",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { timers: [{ grant_id: local.grantId, namespace: "ns", id: "t", criterion_id: "task.reminder", fire_at: future(60_000) }] }
    });
    expect(imported.json()).toEqual({ imported: 0, existing: 0, skipped: 1 });
  });
});

describe("timer service: firing and the fired-timer event", () => {
  async function registerPush(f: Awaited<ReturnType<typeof fixture>>) {
    const channel = await f.app.inject({
      method: "POST",
      url: "/v1/notifications/channels",
      headers: f.auth,
      payload: {
        installation_id: "installation_0123456789",
        criteria: ["task.reminder"],
        subscription: {
          endpoint: "https://push.example/subscription/one",
          expirationTime: null,
          keys: { p256dh: "p256dh_012345678901234567890123456789", auth: "auth_0123456789012345" }
        }
      }
    });
    expect(channel.statusCode).toBe(201);
  }

  async function makeDue(f: Awaited<ReturnType<typeof fixture>>) {
    await f.db.query("UPDATE next_timers SET fire_at = $1", [new Date(Date.now() - 5_000).toISOString()]);
  }

  it("fires once per generation and delivers an opaque push", async () => {
    const f = await fixture();
    await registerPush(f);
    await f.call("PUT", `${f.base}/task-reminders/${"c".repeat(64)}`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    await f.timers!.tick();
    expect(f.transport.deliveries).toHaveLength(0);

    await makeDue(f);
    await f.timers!.tick();
    await f.timers!.tick();
    await eventually(() => f.transport.deliveries.length === 1);
    const payload = JSON.parse(f.transport.deliveries[0].payload);
    const eventId = timerEventId(f.grantId, "task-reminders", "c".repeat(64), 1);
    expect(payload).toEqual({
      type: "mdbase.notification",
      version: 1,
      signal_id: eventId,
      criterion_id: "task.reminder",
      cursor: eventId,
      presentation: CRITERION.presentation
    });
    expect(f.transport.deliveries[0].payload).not.toContain("c".repeat(16));

    const events = await f.db.query<{ data: unknown; late_by_ms: string | number }>("SELECT data, late_by_ms FROM next_timer_events");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data).toBeNull();
    expect(Number(events.rows[0].late_by_ms)).toBeGreaterThanOrEqual(4_000);
    const receipts = await f.db.query<{ consumer: string }>("SELECT consumer FROM next_timer_event_receipts");
    expect(receipts.rows.map((row) => row.consumer)).toEqual(["notifications"]);

    // An identical put does not re-arm a fired timer.
    const listed = await f.call("GET", `${f.base}/task-reminders`);
    const fired = listed.json().timers[0];
    expect(fired.status).toBe("fired");
    const same = await f.call("PUT", `${f.base}/task-reminders/${"c".repeat(64)}`, {
      criterion_id: "task.reminder", fire_at: fired.fire_at
    });
    expect(same.json()).toMatchObject({ status: "fired", generation: 1 });

    // Replaying the consumer produces no second signal.
    await f.db.query("DELETE FROM next_timer_event_receipts");
    await f.timers!.tick();
    const signals = await f.db.query("SELECT id FROM notification_signals");
    expect(signals.rows).toHaveLength(1);
  });

  it("keeps data in cloud-copy events only", async () => {
    const f = await fixture({ hosted: true });
    await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000), data: { k: "v" } });
    await makeDue(f);
    await f.timers!.tick();
    const events = await f.db.query<{ data: unknown }>("SELECT data FROM next_timer_events");
    expect(events.rows[0].data).toEqual({ k: "v" });
  });

  it("never writes data into an event outside a cloud copy", async () => {
    const f = await fixture();
    await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    // Even a row that somehow holds data (e.g. written before a state change).
    await f.db.query(`UPDATE next_timers SET data = '{"leak":true}'::jsonb`);
    await makeDue(f);
    await f.timers!.tick();
    const events = await f.db.query<{ data: unknown }>("SELECT data FROM next_timer_events");
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data).toBeNull();
    const listed = await f.call("GET", `${f.base}/ns`);
    expect(listed.json().timers[0]).not.toHaveProperty("data");
  });

  it("deletes events, receipts and finished timers after the debug window", async () => {
    const f = await fixture();
    await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    await makeDue(f);
    await f.timers!.tick();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    await f.db.query("UPDATE next_timer_events SET created_at = $1", [old]);
    await f.db.query("UPDATE next_timers SET updated_at = $1", [old]);
    await f.timers!.prune(Date.now() + 2 * 60 * 60_000);
    expect((await f.db.query("SELECT event_id FROM next_timer_events")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT event_id FROM next_timer_event_receipts")).rows).toHaveLength(0);
    expect((await f.db.query("SELECT timer_id FROM next_timers")).rows).toHaveLength(0);
  });

  it("cancels the timers of a revoked grant without firing them", async () => {
    const f = await fixture();
    await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    await f.db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [f.grantId]);
    await makeDue(f);
    await f.timers!.tick();
    const rows = await f.db.query<{ status: string }>("SELECT status FROM next_timers");
    expect(rows.rows[0].status).toBe("cancelled");
    expect((await f.db.query("SELECT event_id FROM next_timer_events")).rows).toHaveLength(0);
  });

  it("cancels at fire time when the grant lost the timer criterion", async () => {
    const f = await fixture();
    await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    await f.db.query("UPDATE grants SET notification_criteria = '[]'::jsonb WHERE id = $1", [f.grantId]);
    await makeDue(f);
    await f.timers!.tick();
    const rows = await f.db.query<{ status: string }>("SELECT status FROM next_timers");
    expect(rows.rows[0].status).toBe("cancelled");
  });
});

describe("timer service: cutover copy", () => {
  it("imports legacy cloud-copy timers idempotently", async () => {
    const f = await fixture({ hosted: true });
    const timer = legacyTimer({
      id: "connect:x:task-reminders:timer.6162",
      fire_at: "2030-01-01T00:00:00Z",
      data: { grant_id: f.grantId, criterion_id: "task.reminder", namespace: "task-reminders", timer_id: "ab", data: { secret: 1 } }
    });
    expect(timer).toMatchObject({ grant_id: f.grantId, namespace: "task-reminders", id: "ab" });
    expect(legacyTimer({ fire_at: "2030-01-01T00:00:00Z", data: { foreign: true } })).toBeNull();

    const send = () => f.app.inject({
      method: "POST",
      url: "/internal/v1/next/timers/import",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { timers: [timer, { ...timer!, grant_id: randomUUID() }] }
    });
    expect((await send()).json()).toEqual({ imported: 1, existing: 0, skipped: 1 });
    expect((await send()).json()).toEqual({ imported: 0, existing: 1, skipped: 1 });
    const rows = await f.db.query<{ data: unknown; fire_at: Date | string }>("SELECT data, fire_at FROM next_timers");
    expect(rows.rows[0].data).toEqual({ secret: 1 });
    expect(new Date(rows.rows[0].fire_at).toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("push targets sealed at rest", () => {
  const sealer = () => new PushTargetSealer({ keyId: "k1", key: randomBytes(32), previousKeys: {} });

  it("stores no plaintext target and still delivers", async () => {
    const s = sealer();
    const f = await fixture({ sealer: s });
    const channel = await f.app.inject({
      method: "POST",
      url: "/v1/notifications/channels",
      headers: f.auth,
      payload: {
        installation_id: "installation_0123456789",
        criteria: ["task.reminder"],
        subscription: {
          endpoint: "https://push.example/subscription/sealed",
          expirationTime: null,
          keys: { p256dh: "p256dh_012345678901234567890123456789", auth: "auth_0123456789012345" }
        }
      }
    });
    expect(channel.statusCode).toBe(201);
    const stored = await f.db.query<Record<string, string | null>>(
      "SELECT endpoint, p256dh, auth, fcm_token, sealed_target, sealed_key_id FROM push_channels"
    );
    expect(stored.rows[0]).toMatchObject({ endpoint: null, p256dh: null, auth: null, fcm_token: null, sealed_key_id: "k1" });
    expect(stored.rows[0].sealed_target).not.toContain("push.example");

    await f.call("PUT", `${f.base}/ns/t`, { criterion_id: "task.reminder", fire_at: future(60_000) });
    await f.db.query("UPDATE next_timers SET fire_at = $1", [new Date(Date.now() - 1_000).toISOString()]);
    await f.timers!.tick();
    await eventually(() => f.transport.deliveries.length === 1);
    expect(f.transport.deliveries[0].target.endpoint).toBe("https://push.example/subscription/sealed");

    expect(await unsealPushTargets(f.db, s)).toBe(1);
    const plain = await f.db.query<{ endpoint: string | null }>("SELECT endpoint FROM push_channels");
    expect(plain.rows[0].endpoint).toBe("https://push.example/subscription/sealed");
    expect(await sealExistingPushTargets(f.db, s)).toBe(1);
    expect(await sealExistingPushTargets(f.db, s)).toBe(0);
  });

  it("binds a sealed target to its grant and installation", () => {
    const s = sealer();
    const sealed = s.seal("g1", "i1", { endpoint: "https://push.example/x" });
    expect(s.open("g1", "i1", sealed).endpoint).toBe("https://push.example/x");
    expect(() => s.open("g2", "i1", sealed)).toThrow();
    expect(() => s.open("g1", "i2", sealed)).toThrow();
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
