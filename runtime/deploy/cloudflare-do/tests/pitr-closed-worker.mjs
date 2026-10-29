// Local-only WASM/SDK checks. Fake ports instrument early closure; the exported
// SQLite actor also checks the required all-missing deployment profile on workerd.
import ordinary, { LogCollection as Native } from "../build/worker/shim.mjs";
import required, { LogCollection as Required } from "../src/pitr-worker.mjs";

export class LogCollection extends Required {
  constructor(state, env) { super(state, env); this.testState = state; }
  async fetch(req) {
    if (new URL(req.url).pathname === "/inspect") {
      return Response.json({ tables: [...this.testState.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'")].map(r => r.name), alarm: await this.testState.storage.getAlarm() });
    }
    if (new URL(req.url).pathname === "/alarm-probe") {
      await this.testState.storage.setAlarm(Date.now() + 86_400_000);
      const r = await super.alarm();
      return Response.json({ status: r.status, alarm: await this.testState.storage.getAlarm() });
    }
    return super.fetch(req);
  }
}
async function instrument(q) {
  let reads = 0, bodies = 0, closes = 0, alarms = 0, auto = 0;
  const env = {};
  for (const key of ["LOGSVC_ROOT_KEYS", "LOGSVC_TOKEN_ISSUERS", "LOGSVC_URL_SECRET", "INSECURE_TEST_KEYS", "LOGSVC_CORS_ORIGINS", "LOG", "OBJECTS", "METRICS"]) {
    Object.defineProperty(env, key, { enumerable: true, get() { reads++; throw new Error("unexpected_secret_or_binding_read"); } });
  }
  if (q.flag) Object.defineProperty(env, q.flag, { value: q.value ?? "" });
  const ws = { close() { closes++; }, deserializeAttachment() { throw new Error("unexpected_attachment_read"); }, send() { throw new Error("unexpected_send"); } };
  const state = { waitUntil(promise) { void promise.catch(() => {}); }, getWebSockets() { return [ws]; }, setWebSocketAutoResponse(value) { if (value !== undefined) throw new Error("unexpected_auto_response"); auto++; },
    get storage() { return { get sql() { reads++; throw new Error("unexpected_sql"); }, async deleteAlarm() { alarms++; } }; } };
  const Actor = q.required ? Required : Native;
  const actor = new Actor(state, env);
  const body = new ReadableStream({ pull() { bodies++; throw new Error("unexpected_body_pull"); } }, { highWaterMark: 0 });
  const r = await actor.fetch(new Request("https://do/v1/rpc?c=" + q.collection, { method: "POST", body, duplex: "half" }));
  await actor.webSocketMessage(ws, new Uint8Array([255]));
  await actor.webSocketClose(ws, 1000, "synthetic", true);
  await actor.webSocketError(ws, new Error("synthetic"));
  const alarm = await actor.alarm();
  const outer = [];
  const outerCors = [];
  for (const request of [new Request("https://test/v1/nonce"), new Request("https://test/v1/rpc", {
    method: "OPTIONS", headers: { origin: "https://lab.tasknotes-app.pages.dev", "access-control-request-method": "POST" },
  })]) {
    const response = q.required ? await required.fetch(request, env, {}) : await new ordinary({}, env).fetch(request);
    outer.push(response.status);
    outerCors.push(response.headers.get("access-control-allow-origin"));
  }
  return { status: r.status, cache: r.headers.get("cache-control"), bytes: (await r.arrayBuffer()).byteLength,
    outer, outerCors, alarm: alarm.status, reads, bodies, closes, alarms, auto };
}
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return new Response("local fixture");
    const q = await req.json();
    if (path === "/instrument") return Response.json(await instrument(q));
    if (path === "/ordinary-cors") {
      const origin = "https://lab.tasknotes-app.pages.dev";
      const worker = new ordinary({}, { INSECURE_TEST_KEYS: "1", TESTKIT_CP: "conformance", PUBLIC_BASE: "https://test" });
      const requests = [
        new Request("https://test/v1/rpc", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } }),
        new Request("https://test/v1/rpc", { method: "OPTIONS", headers: { origin: "https://denied.invalid", "access-control-request-method": "POST" } }),
        new Request("https://test/v1/nonce", { headers: { origin } }),
        new Request("https://test/v1/rpc", { method: "POST", headers: { origin } }),
      ];
      const results = [];
      for (const request of requests) {
        const r = await worker.fetch(request);
        results.push({ status: r.status, origin: r.headers.get("access-control-allow-origin"), credentials: r.headers.get("access-control-allow-credentials") });
      }
      return Response.json(results);
    }
    if (path === "/actor") {
      const stub = env.LOG.get(env.LOG.idFromName(q.collection));
      const r = await stub.fetch("https://do/v1/rpc?c=" + q.collection, { method: "POST" });
      const inspect = await (await stub.fetch("https://do/inspect")).json();
      const alarm = await (await stub.fetch("https://do/alarm-probe")).json();
      return Response.json({ status: r.status, ...inspect, alarmProbe: alarm });
    }
    return new Response(null, { status: 404 });
  },
};
