import Fastify from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RelayBrokerUnavailableError } from "../../relay-broker.js";
import { registerNextRouteRoutes } from "./route-routes.js";

// Synthetic rowsets exercise ordering only. PostgreSQL currently permits just one
// registered device per local authority; these are not live admission proofs.
const device = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

async function route(rows: Array<{ device: number; kind?: string; active?: number | null }>, online: number[] = [], result?: unknown, failure?: Error, publicUrl = "https://connect.example") {
  const id = randomUUID();
  const query = vi.fn().mockResolvedValue({ rows: rows.map((r) => ({
    grant_id: id, has_client_key: true, device_id: device(r.device), kind: r.kind ?? "desktop",
    noise_pk: randomBytes(32), local_id: id, connector_id: id, relay_generation: "7", last_active_ms: r.active ?? null
  })) });
  const request = vi.fn(async (_connector: string, _generation: string, command: { message: unknown }) => {
    if (failure) throw failure;
    const named = (command.message as { device_id: string }).device_id;
    return { version: 1 as const, ok: true as const, value: result ?? online.some((n) => named === device(n)) };
  });
  const app = Fastify();
  registerNextRouteRoutes(app, { db: { query }, publicUrl, broker: { request } });
  try {
    const response = await app.inject({ method: "GET", url: `/v1/next/collections/${id}/route`, headers: { authorization: "Bearer unit-token" } });
    return { response, request, query, id };
  } finally {
    await app.close();
  }
}

describe("route target metadata handler (hermetic)", () => {
  it("puts online targets before more recently active offline targets", async () => {
    const { response, request, id } = await route([{ device: 1, active: 500 }, { device: 2, active: 10 }], [2]);
    expect(response.statusCode).toBe(200);
    expect(response.json().targets.map((t: { device: string; online: boolean }) => [t.device, t.online])).toEqual([[device(2), true], [device(1), false]]);
    expect(request).toHaveBeenCalledWith(id, "7", { version: 1, kind: "device_presence", message: { device_id: device(2) } }, 1_000);
  });

  it("ranks daemon candidates before app devices, after online priority", async () => {
    const { response } = await route([{ device: 1, kind: "mobile", active: 100 }, { device: 2, active: 1 }, { device: 3, kind: "cli", active: 2 }], [1, 2, 3]);
    expect(response.json().targets.map((t: { device: string }) => t.device)).toEqual([device(3), device(2), device(1)]);
    const onlineMobile = await route([{ device: 1, kind: "mobile", active: 1 }, { device: 2, active: 100 }], [1]);
    expect(onlineMobile.response.json().targets[0].device).toBe(device(1));
  });

  it("orders equal-tier targets by latest activity, then stable UUID, with null activity last", async () => {
    const { response } = await route([{ device: 4 }, { device: 3, active: 100 }, { device: 2, active: 100 }, { device: 1, active: 200 }]);
    const targets = response.json().targets;
    expect(targets.map((t: { device: string }) => t.device)).toEqual([device(1), device(2), device(3), device(4)]);
    expect(targets.every((t: object) => !("lastActive" in t) && !("last_active_ms" in t) && !("connector_id" in t) && !("relay_generation" in t))).toBe(true);
  });

  it("reports offline on missing/unsupported owners, never treats arbitrary values as online", async () => {
    const missing = await route([{ device: 1 }], [], undefined, new RelayBrokerUnavailableError());
    expect(missing.response.json().targets[0].online).toBe(false);
    const malformed = await route([{ device: 1 }], [], { online: true });
    expect(malformed.response.json().targets[0].online).toBe(false);
  });

  it("does not mask an internal broker failure as ordinary offline", async () => {
    const { response } = await route([{ device: 1 }], [], undefined, new Error("internal"));
    expect(response.statusCode).toBe(500);
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])("uses ws only for loopback development: %s", async (origin) => {
    const { response } = await route([{ device: 1 }], [], undefined, undefined, origin);
    expect(response.json().targets[0].url).toMatch(/^ws:/);
  });

  it("requires wss for non-loopback even if configured HTTP", async () => {
    const { response } = await route([{ device: 1 }], [], undefined, undefined, "http://connect.example");
    expect(response.json().targets[0].url).toBe("wss://connect.example/v1/next/relay/client");
  });
});
