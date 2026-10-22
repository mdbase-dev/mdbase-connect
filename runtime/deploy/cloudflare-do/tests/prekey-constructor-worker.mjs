// Local-only fresh native SDK/actual IDs. No CP requests or accepted witness.
import { DurableObject } from "cloudflare:workers";
import { LogCollection as Native } from "../build/worker/shim.mjs";
const A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const D = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const NIL = "00000000-0000-0000-0000-000000000000";
const RUN = "gate4-pitr-lab-20261009-01";
const METHODS = ["prekeyBegin", "prekeyAccept", "prekeyCurrent", "prekeyFinish"];
function binding(env) {
  return { run: RUN, active: A, deleted: D, codeConfigSha256: "c".repeat(64), members: [
    ...[A, D].map(collection => ({ kind: "log", collection, namespace: "a".repeat(32), object: env.LOG.idFromName(collection).toString() })),
    ...[A, D].map(collection => ({ kind: "hosted", collection, namespace: "b".repeat(32), object: env.HOSTED.idFromName(collection).toString() })),
    { kind: "registry", collection: NIL, namespace: "a".repeat(32), object: env.LOG.idFromName(NIL).toString() },
  ] };
}
export class Probe extends DurableObject {
  async fetch(req) {
    const q = await req.json();
    let privateReads = 0, pulls = 0;
    const profile = binding(this.env);
    const env = { LOGSVC_PITR_REQUIRED: "1", LAB: "1", SERVICE_KIND: "log",
      PITR_MINIMUM_EPOCH: "1", PITR_BINDING: JSON.stringify(profile), LOG: this.env.LOG,
      LOGSVC_ROOT_KEYS: "48075a597e721a156e2e0799de5cc0c5324dc6e7eaf1cdd46250868ec53215dd", CP_URL: "https://cp.example" };
    for (const key of ["LOGSVC_URL_SECRET", "LOGSVC_TOKEN_ISSUERS", "INSECURE_TEST_KEYS", "TESTKIT_CP", "OBJECTS", "METRICS", "PITR_AUTHORITY_TOKEN"]) {
      Object.defineProperty(env, key, { get() { privateReads++; throw new Error("private_config_read"); } });
    }
    if (q.change === "no-roots") delete env.LOGSVC_ROOT_KEYS;
    if (q.change === "zero-roots") env.LOGSVC_ROOT_KEYS = "0".repeat(64);
    if (q.change === "duplicate-roots") env.LOGSVC_ROOT_KEYS += "," + env.LOGSVC_ROOT_KEYS;
    if (q.change === "no-audience") delete env.CP_URL;
    if (q.change === "path-audience") env.CP_URL += "/path";
    if (q.change === "http-audience") env.CP_URL = "http://cp.example";
    if (q.change === "no-binding") delete env.PITR_BINDING;
    if (q.change === "bad-floor") env.PITR_MINIMUM_EPOCH = "9007199254740992";
    if (q.change === "unknown-field") { profile.owner = A; env.PITR_BINDING = JSON.stringify(profile); }
    if (q.change === "duplicate-member") { profile.members[1] = profile.members[0]; env.PITR_BINDING = JSON.stringify(profile); }
    if (q.change === "foreign-namespace") env.LOG = this.env.OTHER;
    if (q.change === "foreign-object") { profile.members[0].object = this.env.OTHER.idFromName(A).toString(); env.PITR_BINDING = JSON.stringify(profile); }
    const native = new Native(this.ctx, env);
    const exports = METHODS.map(name => typeof Native.prototype[name]);
    const errors = [];
    const capture = async work => { try { await work(); errors.push("unexpected_success"); } catch (error) { errors.push(String(error)); } };
    const stream = new ReadableStream({ pull() { pulls++; throw new Error("body_read"); } }, { highWaterMark: 0 });
    const input = new Request("https://do/v1/rpc?c=" + q.collection, { method: "POST", body: stream });
    await capture(() => Native.prototype.prekeyBegin.call(native, input));
    await capture(() => Native.prototype.prekeyAccept.call(native, 1, new Uint8Array(4097)));
    await capture(() => Native.prototype.prekeyCurrent.call(native, 1));
    await capture(() => Native.prototype.prekeyFinish.call(native, 1));
    const before = await native.fetch(new Request("https://do/v1/rpc?c=" + q.collection));
    // Public constructor input is captured once, not renewed from mutable JS
    // objects during a late callback. Physical namespace remains actual SDK data.
    env.CP_URL = "https://replacement.example"; delete env.LOGSVC_ROOT_KEYS;
    await capture(() => Native.prototype.prekeyBegin.call(native, input));
    const after = await native.fetch(new Request("https://do/v1/rpc?c=" + q.collection));
    return Response.json({ exports, errors, pulls, privateReads, serving: [before.status, after.status],
      tables: [...this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%'")].map(row => row.name),
      actualNamespaceDistinct: !this.env.LOG.idFromName(A).equals(this.env.OTHER.idFromName(A)) });
  }
}
export class Other extends Probe {}
export class Hosted extends Probe {}
export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/health") return new Response("isolated native fixture");
    const q = await req.json();
    const namespace = q.physical === "other" ? env.OTHER : env.LOG;
    return namespace.get(namespace.idFromName(q.collection)).fetch("https://probe/check", { method: "POST", body: JSON.stringify(q) });
  },
};
