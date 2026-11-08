import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../database-types.js";
import { createHash } from "node:crypto";
import { activatePendingServices } from "./service-activation.js";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const deployments = { hosted: { url: "https://hosted.test", token: "h".repeat(40) }, escrow: { url: "https://escrow.test", token: "e".repeat(40) } };
function database() {
  const query = vi.fn<DatabaseQueryable["query"]>();
  const result = (rows: object[]) => ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  query.mockResolvedValueOnce(result([{ collection_id: collection, kind: "hosted", batch_id: "9007199254740993" }, { collection_id: collection, kind: "escrow", batch_id: "9007199254740993" }]));
  query.mockResolvedValue(result([]));
  return { query };
}
describe("durable cloud-copy service activation", () => {
  it("LAB logs correlate only hashed collections and fixed outcome facts", async () => {
    vi.stubEnv("MDBASE_CONNECT_ENVIRONMENT", "lab");
    const logs: string[] = []; const logger = vi.spyOn(console, "info").mockImplementation((line: string) => { logs.push(line); });
    try {
      await activatePendingServices(database(), deployments, async () => new Response("private response", { status: 503 }));
      const events = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.filter((e) => e.phase === "sent")).toHaveLength(2);
      expect(events.filter((e) => e.phase === "retry")).toHaveLength(2);
      expect(events.filter((e) => e.phase === "outcome").every((e) => e.http_status === 503 && e.accepted === false)).toBe(true);
      const expectedTag = createHash("sha256").update(`mdbase-service-wake-v1:${collection}`).digest("hex").slice(0, 24);
      expect(events.every((e) => e.collection_tag === expectedTag)).toBe(true);
      expect(expectedTag).toMatch(/^[0-9a-f]{24}$/u);
      for (const forbidden of [collection, deployments.hosted.token, deployments.escrow.token, "private response", "hosted.test", "9007199254740993"]) expect(logs.join("")).not.toContain(forbidden);
    } finally { logger.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("authenticates each kind at its exact configured origin and validates acknowledgment", async () => {
    const db = database(); const seen: Request[] = [];
    await activatePendingServices(db, deployments, async (input, init) => {
      const request = new Request(input, init); seen.push(request);
      return Response.json({ activated: true });
    });
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      const kind = new URL(request.url).hostname === "hosted.test" ? "hosted" : "escrow";
      expect(new URL(request.url).pathname).toBe("/internal/v1/collections/activate");
      expect(request.headers.get("authorization")).toBe(`Bearer ${deployments[kind].token}`);
      expect(request.redirect).toBe("manual");
      expect(await request.json()).toEqual({ collection });
    }
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("SET activated_at"))).toHaveLength(2);
    const selection = db.query.mock.calls[0]![0];
    expect(selection).toContain("parent.sync = 'cloud_copy'");
    expect(selection).toContain("parent.left_sync_at IS NULL");
    expect(selection).toContain("batch.state = 'appended'");
    expect(selection).toContain("batch.lost_at IS NULL");
    expect(selection).toContain("device.activation_batch_id < latest.id");
    expect(selection).toContain("device.activation_attempt_batch_id < latest.id");
    expect(db.query.mock.calls[0]![1]).toEqual([4]);
    expect(db.query.mock.calls[1]![0]).toContain("FROM next_service_retire_wakes wake");
    expect(db.query.mock.calls[1]![1]).toEqual([]);
    expect(db.query.mock.calls.slice(2).map(([,values]) => values)).toEqual([
      [collection, "hosted", "9007199254740993"], [collection, "escrow", "9007199254740993"]
    ]);
    for (const [sql] of db.query.mock.calls.slice(2)) expect(sql).toContain("activation_attempt_batch_id <= $3::bigint");
  });
  it.each(["offline", "redirect", "refused", "not-ack", "extra", "oversized"])("keeps %s pending without persisting arbitrary private error content", async (failure) => {
    const db = database();
    await activatePendingServices(db, deployments, async () => {
      if (failure === "offline") throw new Error("private network detail");
      if (failure === "redirect") return new Response("private response", { status: 302, headers: { location: "https://elsewhere.test" } });
      if (failure === "refused") return new Response("private response", { status: 503 });
      if (failure === "extra") return Response.json({ activated: true, extra: 1 });
      if (failure === "oversized") return new Response("x".repeat(1025));
      return Response.json({ activated: false });
    });
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("SET activated_at"))).toHaveLength(0);
    const retries = db.query.mock.calls.filter(([sql]) => sql.includes("activation_attempts ="));
    expect(retries).toHaveLength(2);
    expect(retries.map(([, values]) => values)).toEqual([[collection, "hosted", "9007199254740993"], [collection, "escrow", "9007199254740993"]]);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("private");
  });
  it.each(["custody_collection_gone", "custody_collection_not_allowed", "custody_not_configured"])("a Worker 409 %s is terminal for that batch: no retry backoff, logged once", async (code) => {
    vi.stubEnv("MDBASE_CONNECT_ENVIRONMENT", "lab");
    const logs: string[] = []; const logger = vi.spyOn(console, "info").mockImplementation((line: string) => { logs.push(line); });
    try {
      const db = database();
      await activatePendingServices(db, deployments, async () => Response.json({ error: code }, { status: 409 }));
      expect(db.query.mock.calls.filter(([sql]) => sql.includes("SET activated_at"))).toHaveLength(0);
      expect(db.query.mock.calls.filter(([sql]) => sql.includes("make_interval"))).toHaveLength(0);
      const terminal = db.query.mock.calls.filter(([sql]) => sql.includes("activation_next_at = 'infinity'"));
      expect(terminal.map(([, values]) => values)).toEqual([[collection, "hosted", "9007199254740993"], [collection, "escrow", "9007199254740993"]]);
      // Only this batch: a newer batch still bypasses (attempt batch < latest) and the row stays unactivated.
      for (const [sql] of terminal) {
        expect(sql).toContain("activation_attempt_batch_id = $3::bigint");
        expect(sql).not.toContain("activation_batch_id =");
        expect(sql).toContain("activation_attempt_batch_id <= $3::bigint");
      }
      const events = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events.filter((e) => e.phase === "refused").map((e) => e.reason)).toEqual([code, code]);
      expect(events.filter((e) => e.phase === "retry")).toHaveLength(0);
    } finally { logger.mockRestore(); vi.unstubAllEnvs(); }
  });
  it.each([
    ["unknown code", () => Response.json({ error: "custody_unavailable" }, { status: 409 })],
    ["extra field", () => Response.json({ error: "custody_collection_gone", extra: 1 }, { status: 409 })],
    ["not JSON", () => new Response("custody_collection_gone", { status: 409 })],
    ["oversized", () => new Response(JSON.stringify({ error: "custody_collection_gone" + "x".repeat(1025) }), { status: 409 })],
    ["refusal on a 200", () => Response.json({ error: "custody_collection_gone" })],
  ])("any other 409 or body (%s) stays pending with bounded retry", async (_name, reply) => {
    const db = database();
    await activatePendingServices(db, deployments, async () => reply());
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("'infinity'"))).toHaveLength(0);
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("make_interval"))).toHaveLength(2);
  });
  describe("retire wakes", () => {
    const queued = "2026-11-08 01:02:03.456789+00";
    function retiring() {
      const query = vi.fn<DatabaseQueryable["query"]>();
      const result = (rows: object[]) => ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
      query.mockResolvedValueOnce(result([]));
      query.mockResolvedValueOnce(result([{ collection_id: collection, kind: "hosted", queued_at: queued }, { collection_id: collection, kind: "escrow", queued_at: queued }]));
      query.mockResolvedValue(result([]));
      return { query };
    }
    it("send the same authenticated activation request, with no verdict or region in it", async () => {
      const seen: Request[] = [];
      await activatePendingServices(retiring(), deployments, async (input, init) => {
        const request = new Request(input, init); seen.push(request);
        return Response.json({ error: "custody_collection_gone" }, { status: 409 });
      });
      expect(seen.map((request) => new URL(request.url).hostname).sort()).toEqual(["escrow.test", "hosted.test"]);
      for (const request of seen) {
        const kind = new URL(request.url).hostname === "hosted.test" ? "hosted" : "escrow";
        expect(new URL(request.url).pathname).toBe("/internal/v1/collections/activate");
        expect(request.headers.get("authorization")).toBe(`Bearer ${deployments[kind].token}`);
        expect(request.redirect).toBe("manual");
        expect(await request.json()).toEqual({ collection });
      }
    });
    it.each([
      ["a lasting verdict", () => Response.json({ error: "custody_collection_gone" }, { status: 409 })],
      ["a current copy", () => Response.json({ activated: true })],
    ])("%s ends only the wake that was sent", async (_name, reply) => {
      const db = retiring();
      await activatePendingServices(db, deployments, async () => reply());
      const done = db.query.mock.calls.filter(([sql]) => sql.startsWith("DELETE FROM next_service_retire_wakes"));
      expect(done.map(([, values]) => values)).toEqual([[collection, "hosted", queued], [collection, "escrow", queued]]);
      for (const [sql] of done) expect(sql).toContain("queued_at = $3::timestamptz");
      expect(db.query.mock.calls.filter(([sql]) => sql.includes("make_interval") || sql.includes("next_service_devices SET"))).toHaveLength(0);
    });
    it("an unknown outcome backs off on the activation schedule", async () => {
      const db = retiring();
      await activatePendingServices(db, deployments, async () => { throw new Error("private network detail"); });
      const retries = db.query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE next_service_retire_wakes"));
      expect(retries.map(([, values]) => values)).toEqual([[collection, "hosted", queued], [collection, "escrow", queued]]);
      for (const [sql] of retries) {
        expect(sql).toContain("make_interval(secs => LEAST(300, (2 * power(2, LEAST(attempts, 8)))::int))");
        expect(sql).toContain("attempts = LEAST(attempts + 1, 9)");
        expect(sql).toContain("queued_at = $3::timestamptz");
      }
      expect(db.query.mock.calls.filter(([sql]) => sql.startsWith("DELETE"))).toHaveLength(0);
      expect(JSON.stringify(db.query.mock.calls)).not.toContain("private");
    });
  });
  describe("retire wakes end", () => {
    it("a wake queued over 24 hours ago is deleted by the selecting statement and never sent", async () => {
      for (const scoped of [undefined, collection]) {
        const db = database(); db.query.mockReset();
        db.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
        await activatePendingServices(db, deployments, vi.fn<typeof fetch>(), scoped);
        const [sql, values] = db.query.mock.calls[1]!;
        expect(sql).toMatch(/^WITH expired AS \(DELETE FROM next_service_retire_wakes old\s+WHERE old\.queued_at < now\(\) - interval '24 hours'/u);
        expect(sql).toContain("wake.next_at <= now() AND wake.queued_at >= now() - interval '24 hours'");
        expect(values).toEqual(scoped ? [collection] : []);
        if (scoped) for (const row of ["old", "wake"]) expect(sql).toContain(`AND ${row}.collection_id = $1::uuid`);
      }
    });
    it("sends at most 20 retire wakes per call; activations keep their own limit", async () => {
      const db = database(); db.query.mockReset();
      db.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
      await activatePendingServices(db, deployments, vi.fn<typeof fetch>());
      expect(db.query.mock.calls[0]![0]).toContain("LIMIT $1");
      expect(db.query.mock.calls[0]![1]).toEqual([4]);
      expect(db.query.mock.calls[1]![0]).toMatch(/ORDER BY wake\.next_at, wake\.collection_id, wake\.kind LIMIT 20$/u);
    });
  });
  it("idle polls do not contact deployments", async () => {
    const db = database(); db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
    const fetcher = vi.fn<typeof fetch>();
    await activatePendingServices(db, deployments, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
