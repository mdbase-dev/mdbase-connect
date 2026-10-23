import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { registerMigrationProviderRoutes } from "./migration-provider.js";
import { labTargetBootstrap, labTargetSubCause } from "./migration-lab-target.js";
import { labRun, type LabConnect, type LabWorker } from "./migration-lab.js";
import { captureLabWorkerError, sanitizedLabOutcome } from "./migration-lab-raw-error.js";

const account = "10000000-0000-4000-8000-000000000001", collection = "20000000-0000-4000-8000-000000000002";
const hold = "30000000-0000-4000-8000-000000000003";
const config = { environment: "lab", url: "https://connect-lab.mdbase.dev", token: "t".repeat(40), account };
const metadata = () => ({ collection_id: collection, owner_account: account, state: "cloud-copy", service_devices: [
  { kind: "hosted", device_id: hold }, { kind: "escrow", device_id: "40000000-0000-4000-8000-000000000004" }
] });
let server: Server, origin: string, requests = 0;
let mode = "ok";
// Injection changes only transport for this test: every call is loopback, with
// the real fetch implementation. No cloud, TLS bypass or production credentials.
const localFetch: typeof fetch = (url, options) => {
  const target = new URL(String(url));
  expect(target.origin).toBe("https://connect-lab.mdbase.dev");
  return fetch(origin + target.pathname, options);
};
beforeAll(async () => {
  server = createServer((request, response) => {
    requests++;
    expect(request.url).toBe(`/internal/v1/next/migration/collections/${collection}/target`);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${config.token}`);
    request.resume();
    if (mode === "fetch") { request.socket.destroy(); return; }
    const value = metadata();
    if (mode === "schema") value.service_devices[0]!.device_id = "private body value never echoed";
    if (mode === "identity") value.owner_account = collection;
    response.statusCode = mode === "http" || mode === "unknown-code" ? 503 : 200;
    response.setHeader("content-type", "application/json");
    response.end(mode === "json" ? "private invalid JSON never echoed" : JSON.stringify(mode === "http" || mode === "unknown-code"
      ? { error: { code: mode === "http" ? "migration_source_unavailable" : "private_code_not_allowlisted", message: "private message never echoed" } } : value));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local_server_not_bound");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("LAB target diagnostics against a real local HTTP server", () => {
  it("accepts the same public canonical metadata, making exactly one request", async () => {
    mode = "ok"; requests = 0;
    await labTargetBootstrap(config, localFetch)(collection);
    expect(requests).toBe(1);
  });
  it("reproduces the real creator's bootstrap-unavailable refusal over local HTTP instead of masking it", async () => {
    const app = Fastify();
    const query = vi.fn(async () => ({ rows: [{ account, started_us: "1000000", display_name: "[test] target" }] }));
    registerMigrationProviderRoutes(app, { token: config.token,
      db: { query } as unknown as Parameters<typeof registerMigrationProviderRoutes>[1]["db"] });
    try {
      const local = await app.listen({ host: "127.0.0.1", port: 0 });
      const transport: typeof fetch = (url, options) => fetch(local + new URL(String(url)).pathname, options);
      const error = await labTargetBootstrap(config, transport)(collection).catch(error => error);
      expect(labTargetSubCause(error, "lab")).toEqual({ call: "http", http_status: 503, api_error_code: "migration_target_unavailable" });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]).toEqual([expect.stringContaining("SELECT"), [collection]]);
    } finally { await app.close(); }
  });
  it.each([undefined, "staging", "production", "LAB"])("does not expose retained LAB causes to %s orchestration", async environment => {
    mode = "http";
    const run = vi.fn(), worker = { run } as unknown as LabWorker;
    const connect = { preflight: async () => ({ collection, backend: "legacy" }), prepareTarget: labTargetBootstrap(config, localFetch) } as Partial<LabConnect> as LabConnect;
    const events: Record<string, unknown>[] = [];
    const outcome = await labRun(account, hold, { worker, connect, environment, log: event => events.push(event) });
    expect(JSON.stringify([events, outcome])).not.toContain("sub_cause");
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    ["http", { call: "http", http_status: 503, api_error_code: "migration_source_unavailable" }],
    ["unknown-code", { call: "http", http_status: 503, api_error_code: "unknown" }],
    ["fetch", { call: "fetch", name: "TypeError" }],
    ["schema", { call: "schema", http_status: 200, zod_path: ["service_devices", 0, "device_id"] }],
    ["json", { call: "json", http_status: 200, reason: "invalid" }],
    ["identity", { call: "identity", http_status: 200, field: "owner_account" }]
  ])("retains token-free %s sub-cause, does not dispatch Worker, and captures privately", async (scenario, cause) => {
    mode = String(scenario); requests = 0;
    const run = vi.fn(async () => { throw new Error("Worker must not be dispatched"); });
    const worker = { run } as unknown as LabWorker;
    const connect = { preflight: async () => ({ collection, backend: "legacy" }), prepareTarget: labTargetBootstrap(config, localFetch) } as Partial<LabConnect> as LabConnect;
    const directory = mkdtempSync(join(process.cwd(), ".target-private-test-")), path = join(directory, "target.json");
    const progress: Record<string, unknown>[] = [];
    try {
      const outcome = await labRun(account, hold, { worker, connect, environment: "lab", log: event => progress.push(captureLabWorkerError(event, "lab", path)) });
      expect(outcome).toMatchObject({ stopped: { step: "prepare_target", reason: "migration_target_unavailable", target_reply: { raw_error: { sub_cause: cause } } } });
      expect(run).not.toHaveBeenCalled(); expect(requests).toBe(1);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ step: "target_reply", raw_error: { sub_cause: cause } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(progress.at(-1)).toEqual({ step: "target_reply", raw_error_capture_status: "saved" });
      const output = JSON.stringify([progress, sanitizedLabOutcome(outcome)]);
      expect(output).not.toContain("sub_cause"); expect(output).not.toContain(config.token);
      expect(output).not.toContain("private"); expect(readFileSync(path, "utf8")).not.toContain("private");
    } finally { rmSync(directory, { recursive: true }); }
  });
  it.each([
    [{ url: "private invalid URL" }, "origin"], [{ token: "private short" }, "token"],
    [{ account: "private account" }, "account"]
  ])("records the exact failed guard with zero HTTP requests", async (override, guard) => {
    requests = 0;
    const error = await labTargetBootstrap({ ...config, ...override }, localFetch)(collection).catch(error => error);
    expect(labTargetSubCause(error, "lab")).toEqual({ call: "guard", guard });
    expect(labTargetSubCause(error, "staging")).toBeUndefined();
    expect(requests).toBe(0);
    expect(JSON.stringify(labTargetSubCause(error, "lab"))).not.toContain("private");
  });
});
