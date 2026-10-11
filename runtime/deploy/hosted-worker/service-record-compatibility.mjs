/** Offline structural compatibility of a CP record with an exact compiled
 * keying-service consumer. This is NOT custody, crypto, keying or read authority.
 * Inputs must already be authenticated release artifacts; VM is not a security
 * sandbox for arbitrary code. No real credentials, network or unwrap are used.
 */
import { createHash } from "node:crypto";
import vm from "node:vm";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const MAX_BUNDLE_BYTES = 8 << 20;
const MAX_RECORD_BYTES = 128 << 10;
const DEADLINE_MS = 5_000;
const COLLECTION = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const FIELDS = ["kind", "device_id", "sign_pk", "kem_pk", "noise_pk", "wrapped_keys", "kms_key_arn", "genesis"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Extract the one self-contained esbuild ControlClient module, byte-exact.
 * Unsupported/minified/ambiguous layouts refuse; no source-file substitute.
 */
export function controlModule(bundle) {
  const markers = [...bundle.matchAll(/^\/\/ (?:[^\r\n]*\/)?src\/control\.ts\r?$/gm)];
  if (markers.length !== 1) throw new Error("unsupported_consumer_bundle");
  const start = markers[0].index + markers[0][0].length + 1;
  const end = bundle.indexOf("\n// ", start);
  if (end < start) throw new Error("unsupported_consumer_bundle");
  const module = bundle.slice(start, end);
  if (!/\bvar ControlClient = class\b/.test(module)) throw new Error("unsupported_consumer_bundle");
  return module;
}

function input(bundleBytes, recordBytes, role) {
  if (!["hosted", "escrow"].includes(role) || !(bundleBytes instanceof Uint8Array) ||
      !bundleBytes.length || bundleBytes.length > MAX_BUNDLE_BYTES || !(recordBytes instanceof Uint8Array) ||
      !recordBytes.length || recordBytes.length > MAX_RECORD_BYTES) throw new Error("invalid_qualification_input");
  let record;
  let bundle;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recordBytes));
    bundle = new TextDecoder("utf-8", { fatal: true }).decode(bundleBytes);
  } catch { throw new Error("invalid_qualification_input"); }
  // Exact canonical JSON binds the report to supplied bytes and rejects duplicates.
  if (!Buffer.from(recordBytes).equals(Buffer.from(JSON.stringify(record) + "\n")) ||
      !record || Array.isArray(record) || Object.keys(record).length !== FIELDS.length ||
      !FIELDS.every(k => Object.hasOwn(record, k)) || record.kind !== role ||
      !record.genesis || record.genesis.seq !== 1) throw new Error("invalid_qualification_input");
  return { module: controlModule(bundle) };
}

/** Qualify one role against CP-produced canonical JSON and a frozen Wrangler
 * bundle. Release tooling must separately bind CP image, WASM/trust hashes and
 * BOTH active Worker version IDs; this report alone never authorizes deployment.
 */
export async function qualifyServiceRecordConsumer({ bundleBytes, recordBytes, role }) {
  const { module } = input(bundleBytes, recordBytes, role);
  const binding = {
    schemaVersion: 1,
    scope: "structural-service-record-compatibility",
    role,
    bundleSha256: sha(bundleBytes),
    consumerSha256: sha(module),
    recordSha256: sha(recordBytes),
  };
  // A separate, credential-free worker provides a hard bound even for a stalled
  // artifact continuation. This is a trusted-artifact test, not a code sandbox.
  const outcome = await new Promise(resolve => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { module, recordBytes, role }, env: {}, execArgv: [],
    });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().then(() => resolve(result));
    };
    const timer = setTimeout(() => finish({ compatible: false, failure: "qualifier_timeout" }), DEADLINE_MS);
    worker.once("message", finish);
    worker.once("error", () => finish({ compatible: false, failure: "artifact_runtime_failure" }));
    worker.once("exit", () => finish({ compatible: false, failure: "artifact_runtime_failure" }));
  });
  return { ...binding, ...outcome };
}

async function checkConsumer({ module, recordBytes, role }) {
  const record = JSON.parse(Buffer.from(recordBytes));
  const context = vm.createContext({ __name: value => value, URL, AbortSignal, AbortController, setTimeout, clearTimeout, Uint8Array, TextDecoder, atob, btoa });
  const Consumer = new vm.Script(module + "\nControlClient").runInContext(context, { timeout: 1_000 });
  let calls = 0;
  const read = async reply => {
    const client = new Consumer({ url: "https://cp.test", token: "fixture".repeat(6), kind: role }, async (url, init) => {
      calls++;
      if (url !== `https://cp.test/internal/v1/next/collections/${COLLECTION}/service-devices/${role}` ||
          init.method !== "GET" || init.redirect !== "manual") throw new Error("fixture_transport_mismatch");
      return Response.json(reply);
    });
    return client.serviceDevice(COLLECTION, new AbortController().signal);
  };
  let accepted;
  try { accepted = await read(record); }
  catch (error) {
    return { compatible: false, failure: error?.code === "invalid" ? "record_contract_refused" : "artifact_runtime_failure" };
  }
  const same = (a, b) => a instanceof Uint8Array && Buffer.from(a).equals(b);
  if (accepted.kind !== role || accepted.deviceId !== record.device_id ||
      !same(accepted.signPk, Buffer.from(record.sign_pk, "hex")) ||
      !same(accepted.kemPk, Buffer.from(record.kem_pk, "hex")) ||
      !same(accepted.noisePk, Buffer.from(record.noise_pk, "hex")) ||
      !same(accepted.wrappedKeys, Buffer.from(record.wrapped_keys, "base64")) ||
      accepted.kmsKeyArn !== record.kms_key_arn || accepted.genesis?.seq !== 1 ||
      !same(accepted.genesis?.item, Buffer.from(record.genesis.item, "base64")) ||
      !same(accepted.genesis?.hash, Buffer.from(record.genesis.hash, "hex"))) {
    return { compatible: false, failure: "record_projection_mismatch" };
  }
  const { genesis: _removed, ...missingGenesis } = record;
  const bad = [
    missingGenesis,
    { ...record, kind: role === "hosted" ? "escrow" : "hosted" },
    { ...record, extra: true },
    { ...record, genesis: { ...record.genesis, seq: 2 } },
    { ...record, genesis: { ...record.genesis, item: "" } },
    { ...record, genesis: { ...record.genesis, hash: "not-a-checksum" } },
  ];
  for (const reply of bad) {
    try { await read(reply); return { compatible: false, failure: "invalid_record_accepted" }; }
    catch (error) {
      if (error?.code !== "invalid") return { compatible: false, failure: "artifact_runtime_failure" };
    }
  }
  return { compatible: true, checkedRefusals: bad.length, fixtureFetchCalls: calls, networkRequests: 0, unwrapCalls: 0 };
}

if (!isMainThread) {
  checkConsumer(workerData).then(result => parentPort.postMessage(result),
    () => parentPort.postMessage({ compatible: false, failure: "artifact_runtime_failure" }));
}
