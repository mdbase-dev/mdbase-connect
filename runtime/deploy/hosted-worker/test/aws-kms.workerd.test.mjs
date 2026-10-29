import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { build } from "esbuild";
import workerd from "workerd";
import { fileURLToPath } from "node:url";

const workerdPath = workerd.default;
const project = fileURLToPath(new URL("../", import.meta.url));
const arn = "arn:aws:kms:ap-southeast-1:000000000000:key/33333333-3333-4333-8333-333333333333";
function worker(endpoint) {
  return `
import { HostedAwsKms } from "./src/custody/aws-kms.ts";
const collection="11111111-1111-4111-8111-111111111111";
const device="22222222-2222-4222-8222-222222222222";
const arn=${JSON.stringify(arn)};
export default { async fetch(incoming) {
  const path=new URL(incoming.url).pathname;
  const explicit=path.endsWith("explicit"), escrow=path.startsWith("/escrow");
  const args=explicit?[fetch]:[]; // productionParts passes raw global fetch explicitly.
  const kms=new HostedAwsKms({keyArn:arn,region:"ap-southeast-1",environment:escrow?"staging":"lab",collections:[collection],...(escrow?{role:"escrow"}:{})},
    ()=>({accessKeyId:"A".repeat(20),secretAccessKey:"x".repeat(40)}),...args);
  // Test-only destination substitution: no production endpoint/config change.
  kms.endpoint=${JSON.stringify(endpoint)}+(escrow?"escrow":"");
  try {
    const wrapped=await kms.wrapDeviceKeys({collection,device,secret:new Uint8Array(96)},AbortSignal.timeout(8000));
    return Response.json({ok:true,envelope_bytes:wrapped.envelope.length});
  } catch(error) {
    const allowed=["kms_unavailable","kms_refused","kms_aborted","kms_invalid_response","kms_credentials_unavailable"];
    return Response.json({ok:false,code:error instanceof Error&&allowed.includes(error.message)?error.message:"unknown"});
  }
}};
`;
}

test("workerd hosted/staging-escrow contexts with default and raw transport reach only loopback KMS", { timeout: 20000 }, async () => {
  const artifactRoot = resolve(project, "../../.artifacts");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(artifactRoot, "kms-runtime-"));
  const server = fork(new URL("./fixtures/kms-loopback.mjs", import.meta.url), { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let runtime;
  const results = [];
  let counts;
  try {
    const [{ port }] = await once(server, "message", { signal: AbortSignal.timeout(5000) });
    const output = await build({ stdin: { contents: worker(`http://127.0.0.1:${port}/`), resolveDir: project, loader: "ts" }, bundle: true,
      format: "esm", platform: "browser", target: "es2022", write: false });
    await writeFile(resolve(root, "worker.js"), output.outputFiles[0].text);
    const schema = fileURLToPath(import.meta.resolve("workerd/workerd.capnp"));
    await writeFile(resolve(root, "config.capnp"), `using Workerd = import ${JSON.stringify(schema)};
const config :Workerd.Config = (
 services = [(name = "main", worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-10-13", compatibilityFlags = ["nodejs_compat"]
  )), (name = "internet", network = (allow = ["127.0.0.0/8"]))],
 sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")]
);
`);
    runtime = spawn(workerdPath, ["serve", resolve(root, "config.capnp"), "--control-fd=3", "-I", "/"], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    // Runtime diagnostics here contain only this synthetic fixture; drain them.
    runtime.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const control = createInterface({ input: runtime.stdio[3] });
    const [{ port: workerPort }] = await once(control, "line", { signal: AbortSignal.timeout(5000) }).then(([line]) => [JSON.parse(line)]);
    assert.ok(Number.isInteger(workerPort) && workerPort > 0 && workerPort < 65536);
    for (const mode of ["/default", "/explicit", "/escrow-default", "/escrow-explicit"]) {
      const result = await (await fetch(`http://127.0.0.1:${workerPort}${mode}`, { signal: AbortSignal.timeout(10000) })).json();
      results.push({ mode, result });
    }
    const answer = once(server, "message"); server.send("counts"); [counts] = await answer;
    control.close();
  } finally {
    if (runtime && runtime.exitCode === null) { runtime.kill("SIGTERM"); await once(runtime, "exit"); }
    if (server.connected) server.disconnect();
    if (server.exitCode === null) await once(server, "exit");
    await rm(root, { recursive: true, force: true });
  }
  for (const { mode, result } of results) {
    assert.equal(result.ok, true, JSON.stringify({ mode, result, counts }));
    assert.ok(result.envelope_bytes > 0);
  }
  assert.deepEqual(counts, { calls: 4, invalid: 0 });
});
