// `pnpm e2e`: one happy path through the runtime daemon's request path.
//
// A local control plane (in-memory database, development sign-in) and the
// runtime daemon, driven by the real `mdbase` CLI: sign the computer in and
// approve it on the control plane, register a folder, read a record, write
// records and see them on disk, then sign out and see the next read refused.
// The daemon is `runtime/crates/daemon/examples/loopback_daemon.rs`: the same
// `server::run` as `mdbase daemon run`, allowed to sign in to loopback.
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { availableTcpPort, poll } from "./lib/test-runtime.mjs";

process.env.NODE_ENV = "test";
process.env.MDBASE_NEW_ACCOUNT_BACKEND = "next";
const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const bin = (name) => join(repoRoot, "runtime", "target", "debug", name);
const mdbaseBinary = bin("mdbase");
const daemonBinary = bin(join("examples", "loopback_daemon"));

// Throwaway per-run next control-plane keys. Local collections never reach the
// log service, so its URL points nowhere. The in-memory database cannot run the
// relay's grant-inventory query, so the server logs "connector policy stage
// failed" and no app grants reach the daemon; this path does not need them.
function nextControlPlane() {
  const ed25519 = () => generateKeyPairSync("ed25519");
  const pem = (key) => key.export({ format: "pem", type: "pkcs8" }).toString();
  const root = ed25519();
  const policy = ed25519();
  const rootPublicKey = ed25519RawPublicKey(root.privateKey);
  const now = Date.now();
  const unsigned = {
    policyPublicKey: ed25519RawPublicKey(policy.privateKey),
    notBefore: now - 60_000,
    notAfter: now + 30 * 86_400_000,
    root: keyId(rootPublicKey)
  };
  return {
    rootPublicKey,
    policyPrivateKeyPem: pem(policy.privateKey),
    policyCert: certToJson({ ...unsigned, signature: sign(null, certDigest(unsigned), root.privateKey) }),
    logService: { url: "http://127.0.0.1:9", tokenIssuerKeyPem: pem(ed25519().privateKey), transportKeyPem: pem(ed25519().privateKey) }
  };
}

const port = await availableTcpPort();
const serverUrl = `http://127.0.0.1:${port}`;
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const { certToJson, ed25519RawPublicKey } = await import("../services/server/dist/features/next/policy-keys.js");
const { certDigest, keyId } = await import("../services/server/dist/features/next/policy-wire.js");
const { app } = await buildApp({
  db: await createDatabase("memory"),
  devAuth: true,
  publicUrl: serverUrl,
  nextControlPlane: nextControlPlane()
});
await app.listen({ host: "127.0.0.1", port });

// Short: the daemon's Unix sockets live under the state directory.
const scratch = await mkdtemp(join(tmpdir(), "mdbe-"));
const state = join(scratch, "s");
const folder = join(scratch, "notes");
const env = {
  ...process.env,
  MDBASE_ENV: "test",
  MDBASE_SECRET_BACKEND: "insecure-test-file",
  // Never let the isolated daemon find this computer's connector state.
  MDBASE_CONNECT_HOME: join(scratch, "no-connect"),
  MDBASE_HOME: state
};
let daemon;

let daemonLog = "";
const step = (name) => console.log(`ok - ${name}`);

// The real CLI, as a separate process; its failures carry the CLI's own output.
async function mdbase(...args) {
  try {
    const { stdout } = await run(mdbaseBinary, ["--state-dir", state, "--json", ...args], { env, cwd: scratch });
    return JSON.parse(stdout);
  } catch (error) {
    error.message = `mdbase ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`;
    throw error;
  }
}

try {
  await mkdir(join(folder, "_types"), { recursive: true });
  await mkdir(join(folder, "tasks"));
  await writeFile(join(folder, "mdbase.yaml"), 'spec_version: "0.3.0"\nname: Notes\n');
  await writeFile(join(folder, "_types", "task.md"), [
    "---", "kind: mdbase.type", "name: task", "version: 1", "schema:",
    "  dialect: json-schema-2020-12", "  value:", "    type: object", "    required: [title, status]",
    "    properties:", "      title: { type: string }", "      status: { type: string, enum: [open, done] }",
    "---", ""
  ].join("\n"));
  await writeFile(join(folder, "tasks", "a.md"), "---\ntype: task\ntitle: Write docs\nstatus: open\n---\nBody A.\n");

  daemon = spawn(daemonBinary, [state], { env, stdio: ["ignore", "ignore", "pipe"] });
  daemon.stderr.on("data", (chunk) => { daemonLog += chunk; });
  const exited = new Promise((_, reject) => daemon.once("exit", (code) => reject(new Error(`daemon exited (${code})`))));
  exited.catch(() => undefined);
  await Promise.race([exited, poll(async () => (await mdbase("daemon", "status")).readiness.ready, "daemon never became ready")]);
  step("runtime daemon ready");

  const session = await fetch(`${serverUrl}/v1/dev/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "E2E User", email: "e2e@example.com" })
  });
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!session.ok || !cookie) throw new Error(`development sign-in failed (${session.status})`);
  const signIn = await mdbase("account", "sign-in", "--server", serverUrl);
  const pairing = new URL(signIn.verification_uri).pathname.split("/").pop();
  const approval = await fetch(`${serverUrl}/v1/pairing-requests/${pairing}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}"
  });
  if (!approval.ok) throw new Error(`pairing approval failed (${approval.status}): ${await approval.text()}`);
  await poll(async () => {
    const { account } = await mdbase("status");
    if (account.last_error && !account.pairing) throw new Error(`sign-in failed: ${JSON.stringify(account.last_error)}`);
    return account.signed_in && !account.pairing;
  }, "the daemon never finished signing in");
  step("computer signed in and approved on the local control plane");

  const added = await mdbase("collection", "add", folder, "--name", "Notes");
  await poll(async () => (await mdbase("collection", "list")).some((c) => c.id === added.id && c.state === "ready"),
    "the collection never became ready");
  step(`folder registered as collection ${added.id}`);

  const read = await mdbase("read", "tasks/a.md", "-C", folder);
  if (JSON.stringify(read).indexOf("Write docs") < 0) throw new Error(`unexpected read: ${JSON.stringify(read)}`);
  step("record read through the daemon");

  await mdbase("create", "--path", "tasks/b.md", "--type", "task", "--fields", '{"title":"Ship","status":"open"}', "-C", folder);
  await mdbase("update", "tasks/a.md", "--fields", '{"status":"done"}', "-C", folder);
  const created = await readFile(join(folder, "tasks", "b.md"), "utf8");
  const updated = await readFile(join(folder, "tasks", "a.md"), "utf8");
  if (!/title: Ship/.test(created) || !/status: done/.test(updated)) {
    throw new Error(`writes did not land on disk:\n${created}\n${updated}`);
  }
  step("create and update landed on disk");

  await mdbase("account", "sign-out");
  const refused = await mdbase("read", "tasks/a.md", "-C", folder).then(
    () => { throw new Error("read succeeded after sign-out"); },
    (error) => JSON.parse(error.stdout)
  );
  if (refused.error?.reason !== "account_identity_missing") throw new Error(`unexpected refusal: ${JSON.stringify(refused)}`);
  step("signed out; the next read was refused (account_identity_missing)");
} catch (error) {
  if (daemonLog) console.error(`daemon log:\n${daemonLog}`);
  throw error;
} finally {
  if (daemon && daemon.exitCode === null) {
    await run(mdbaseBinary, ["--state-dir", state, "daemon", "stop"], { env }).catch(() => daemon.kill());
  }
  await app.close();
  await rm(scratch, { recursive: true, force: true });
}
