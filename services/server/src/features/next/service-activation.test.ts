import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../database-types.js";
import { activatePendingServices } from "./service-activation.js";

const collection = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const deployments = { hosted: { url: "https://hosted.test", token: "h".repeat(40) }, escrow: { url: "https://escrow.test", token: "e".repeat(40) } };
function database() {
  const query = vi.fn<DatabaseQueryable["query"]>();
  const result = (rows: object[]) => ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] });
  query.mockResolvedValueOnce(result([{ collection_id: collection, kind: "hosted" }, { collection_id: collection, kind: "escrow" }]));
  query.mockResolvedValue(result([]));
  return { query };
}
describe("durable cloud-copy service activation", () => {
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
    expect(db.query.mock.calls[0]![1]).toEqual([4]);
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
    expect(retries.map(([, values]) => values)).toEqual([[collection, "hosted"], [collection, "escrow"]]);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain("private");
  });
  it("idle polls do not contact deployments", async () => {
    const db = database(); db.query.mockReset();
    db.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
    const fetcher = vi.fn<typeof fetch>();
    await activatePendingServices(db, deployments, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
