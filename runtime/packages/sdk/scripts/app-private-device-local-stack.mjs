/** LOCAL TEST stack identity and build inputs for app-private-device-local-e2e.mjs.
 *
 * One owned per-checkout "local" stack under runtime/target/private-device-e2e:
 * throwaway root, policy, log-token and transport keys, two fixed loopback
 * origins, and the signed local trust asset that the SDK application build and
 * the `local-rehearsal` daemon embed (the product's own per-stack local path:
 * build-local-application.mjs, build-local-native-trust.mjs, mdbn-trust
 * verify-local). The identity is kept between runs because the native artifact
 * is compiled against it; delete the directory to start a new one.
 *
 * Nothing here is LAB, staging or production trust, and no managed artifact is
 * produced or modified: the server bundle and the SDK overlay are separate
 * outputs with the local literal, exactly as `build:local` and
 * build-local-application.mjs make them. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildLocalApplication } from "./build-local-application.mjs";
import { buildLocalNativeTrust } from "../../../scripts/build-local-native-trust.mjs";

const sdk = fileURLToPath(new URL("..", import.meta.url));
export const runtimeRoot = resolve(sdk, "../..");
export const checkout = resolve(runtimeRoot, "..");
export const e2eRoot = join(runtimeRoot, "target/private-device-e2e");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const privateJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const note = message => process.stdout.write(`   ${message}\n`);

/** The server's own source as ONE local artifact: the entry (`index.ts`), the
 * key helpers the stack is signed with and the one account write the test's
 * development sign-in lacks (`provisionNewAccountBackend`). Same literal replacement as
 * services/server/scripts/mark-local-build.mjs; services/server/dist is untouched. */
export async function bundleLocalServer() {
  const out = join(e2eRoot, "server"), source = join(checkout, "services/server");
  mkdirSync(join(out, "dist"), { recursive: true });
  for (const name of ["node_modules", "migrations"]) {
    const link = join(out, name);
    if (!existsSync(link)) symlinkSync(join(source, name), link, "dir");
  }
  const managed = "export const LOCAL_REHEARSAL_BUILD: boolean = false;";
  const local = { name: "local-server-literal", setup(builder) {
    builder.onLoad({ filter: /[\\/]platform[\\/]local-build\.ts$/ }, args => {
      const text = readFileSync(args.path, "utf8");
      if (text.split(managed).length !== 2) throw Error("expected the managed local-build literal");
      return { contents: text.replace(managed, "export const LOCAL_REHEARSAL_BUILD: boolean = true;"), loader: "ts" };
    });
  } };
  const mod = name => JSON.stringify(join(source, `src/${name}.ts`));
  await build({ entryPoints: { index: join(source, "src/index.ts") }, outdir: join(out, "dist"), bundle: true, packages: "external",
    platform: "node", format: "esm", target: "node22", plugins: [local], logLevel: "warning" });
  await build({ stdin: { contents: `export {certToJson,ed25519RawPublicKey} from ${mod("features/next/policy-keys")};export {certDigest,keyId} from ${mod("features/next/policy-wire")};export {provisionNewAccountBackend} from ${mod("features/next/account-backend-flip")};`, resolveDir: source },
    outfile: join(out, "dist/keys.mjs"), bundle: true, packages: "external", platform: "node", format: "esm", target: "node22", plugins: [local], logLevel: "warning" });
  return { entry: join(out, "dist/index.js"), keys: await import(pathToFileURL(join(out, "dist/keys.mjs")).href) };
}

function freePort() {
  const script = "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});";
  return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
}

/** Create (once) or read the stack identity. The policy certificate is long
 * lived so that the compiled native artifact stays usable between runs. */
export function ensureStack(keys) {
  const directory = join(e2eRoot, "stack"), configFile = join(directory, "local-stack.json");
  if (!existsSync(configFile)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const revision = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw Error("source revision required");
    const pair = () => generateKeyPairSync("ed25519").privateKey, hex = bytes => Buffer.from(bytes).toString("hex");
    const pem = key => key.export({ type: "pkcs8", format: "pem" }).toString();
    const root = pair(), policy = pair(), issuer = pair(), transport = pair(), rootPk = keys.ed25519RawPublicKey(root);
    const connectOrigin = `http://127.0.0.1:${freePort()}`, logOrigin = `http://127.0.0.1:${freePort()}`;
    const unsigned = { policyPublicKey: keys.ed25519RawPublicKey(policy), notBefore: Date.now() - 60_000, notAfter: Date.now() + 3650 * 86_400_000, root: keys.keyId(rootPk) };
    const certificate = keys.certToJson({ ...unsigned, signature: sign(null, keys.certDigest(unsigned), root) });
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const asset = Buffer.from(JSON.stringify(canonical({ schema_version: 1, environment: "local", control_plane_origin: connectOrigin, log_origin: logOrigin,
      issued_at: Date.now(), source: { repository: "mdbase-dev/mdbase-connect", commit: revision, version: "local" },
      roots: [{ key_id: hex(keys.keyId(rootPk)), public_key: hex(rootPk) }],
      policy_keys: [{ key_id: hex(keys.keyId(unsigned.policyPublicKey)), certificate }] })));
    writeFileSync(join(directory, "local-trust.json"), asset, { mode: 0o600, flag: "wx" });
    writeFileSync(join(directory, "local-root.pem"), pem(root), { mode: 0o600, flag: "wx" });
    // The server's own environment, as `index.ts` reads it. The database URL and
    // the app-device switch are per run and are added by the test.
    privateJson(join(directory, "job-env.json"), { HOST: "127.0.0.1", PORT: new URL(connectOrigin).port, PUBLIC_URL: connectOrigin, NODE_ENV: "development",
      MDBASE_CONNECT_ENVIRONMENT: "local", MDBASE_CONNECT_REVISION: revision, MDBASE_CONNECT_DEV_AUTH: "1", MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS: "1",
      MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET: randomBytes(32).toString("hex"),
      MDBASE_NEXT_CONTROL_PLANE: "1", MDBASE_NEXT_ROOT_PUBLIC_KEY: hex(rootPk), MDBASE_NEXT_POLICY_SIGNING_KEY: pem(policy),
      MDBASE_NEXT_POLICY_KEY_CERT: JSON.stringify(certificate), MDBASE_NEXT_LOG_SERVICE_URL: logOrigin,
      MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: pem(issuer), MDBASE_NEXT_LOG_TRANSPORT_KEY: pem(transport), MDBASE_NEXT_PRIVATE_BOOTSTRAP: "1" });
    privateJson(join(directory, "log-env.json"), { LOGSVC_ROOT_KEYS: hex(rootPk), LOGSVC_TOKEN_ISSUERS: hex(keys.ed25519RawPublicKey(issuer)), LOGSVC_URL_SECRET: randomBytes(32).toString("hex") });
    privateJson(configFile, { environment: "local", connectEnvFile: join(directory, "job-env.json"), connectOrigin, logOrigin, revision });
    note(`new local stack identity: ${connectOrigin} (Connect), ${logOrigin} (log service)`);
  }
  if ((statSync(directory).mode & 0o777) !== 0o700) throw Error("the local stack directory must be private (0700)");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  return { directory, configFile, config, assetSha256: sha(readFileSync(join(directory, "local-trust.json"))),
    serverEnv: JSON.parse(readFileSync(config.connectEnvFile, "utf8")), logEnv: JSON.parse(readFileSync(join(directory, "log-env.json"), "utf8")) };
}

/** cargo, or rcargo (which copies only named artifacts back). */
function cargo(args, pulls) {
  const command = process.env.MDBASE_E2E_CARGO ?? "cargo", remote = basename(command) === "rcargo";
  const argv = remote ? [...pulls.flatMap(name => ["--pull", name]), ...args] : args;
  note(`${command} ${argv.join(" ")}`);
  for (let attempt = 0; ; attempt++) {
    const result = spawnSync(command, argv, { cwd: runtimeRoot, stdio: ["ignore", "inherit", "inherit"] });
    if (result.status === 0) return;
    // rcargo: 255 is a lost connection to the builder, not a build failure.
    if (!remote || result.status !== 255 || attempt === 2) throw Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
  }
}

/** The local verifier and the native log service. Built only when absent, or with `rebuild`. */
export function ensureTools(rebuild) {
  const verifier = join(runtimeRoot, "target/debug/mdbn-trust"), log = join(runtimeRoot, "target/debug/mdbn-log-server");
  if (rebuild || !existsSync(verifier) || !existsSync(log))
    cargo(["build", "--locked", "-p", "mdbn-trust", "-p", "mdbn-log-server", "--features", "mdbn-trust/local-rehearsal"], ["mdbn-trust", "mdbn-log-server"]);
  // A managed verifier has no verify-local; refuse it here rather than at the first build step.
  const probe = spawnSync(verifier, ["verify-local"], { encoding: "utf8" });
  if (probe.status !== 2 || !/usage/.test(probe.stderr + probe.stdout)) throw Error("mdbn-trust did not answer as the build verifier");
  return { verifier, log };
}

/** The app runtime artifact (`app-runtime` feature), optimised as the SDK packages it. */
export function ensureAppRuntime(rebuild) {
  const artifact = join(runtimeRoot, "target/wasm/app-runtime.wasm");
  if (!rebuild && existsSync(artifact)) return artifact;
  const raw = "wasm32-unknown-unknown/wasm-release/mdbn_wasm.wasm", optimiser = join(runtimeRoot, "tools/wasm/node_modules/.bin/wasm-opt");
  if (!existsSync(optimiser)) execFileSync("npm", ["ci", "--prefix", join(runtimeRoot, "tools/wasm"), "--ignore-scripts"], { stdio: "inherit" });
  cargo(["build", "--locked", "-p", "mdbn-wasm", "--lib", "--target", "wasm32-unknown-unknown", "--profile", "wasm-release", "--features", "app-runtime"], [raw]);
  mkdirSync(dirname(artifact), { recursive: true });
  execFileSync(optimiser, ["-Oz", "--converge", "--enable-bulk-memory", "--enable-bulk-memory-opt", "--enable-sign-ext", "--enable-mutable-globals",
    "--enable-nontrapping-float-to-int", "--enable-reference-types", "--enable-multivalue", "--strip-debug", "--strip-producers",
    join(runtimeRoot, "target", raw), "-o", artifact], { stdio: "inherit" });
  return artifact;
}

/** The desktop: the real `mdbase` binary as its `local-rehearsal` artifact, which
 * embeds this stack's signed trust asset and signs in only to its Connect origin.
 * Kept apart from target/debug/mdbase, and rebuilt when the stack identity changes. */
export function ensureDesktop(stack, verifier, rebuild) {
  const binary = join(e2eRoot, "bin/mdbase-local"), stamp = `${binary}.trust`, inputs = join(runtimeRoot, "crates/daemon/trust");
  if (!rebuild && existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8") === stack.assetSha256) return binary;
  // Generated, ignored compiler inputs (crates/daemon/trust/.gitignore); create-only upstream.
  for (const name of ["local.json", "local-context.rs"]) rmSync(join(inputs, name), { force: true });
  rmSync(join(stack.directory, "native-verified-release.ts"), { force: true });
  buildLocalNativeTrust({ stackConfig: stack.configFile, verifier, outputDirectory: inputs });
  cargo(["build", "--locked", "-p", "mdbn-daemon", "--bin", "mdbase", "--features", "local-rehearsal"], ["mdbase"]);
  mkdirSync(dirname(binary), { recursive: true });
  cpSync(join(runtimeRoot, "target/debug/mdbase"), binary);
  // The default-feature binary of the same name must not be mistaken for this one.
  rmSync(join(runtimeRoot, "target/debug/mdbase"), { force: true });
  writeFileSync(stamp, stack.assetSha256);
  return binary;
}

function treeDigest(directory) {
  const hash = createHash("sha256");
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) hash.update(path.slice(directory.length)).update("\0").update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest("hex");
}

/** The SDK as the product's local application build (build-local-application.mjs):
 * the current SDK source, this stack's verified trust and the app runtime bytes.
 * Rebuilt whenever any of the three changes. */
export function ensureLocalSdk(stack, verifier, runtimeFile) {
  const output = join(e2eRoot, "sdk-local"), stampFile = `${output}.inputs`;
  const stamp = [stack.assetSha256, sha(readFileSync(runtimeFile)), treeDigest(join(sdk, "src")), sha(readFileSync(join(sdk, "scripts/build-local-application.mjs")))].join(":");
  if (existsSync(output) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return output;
  if (!lstatSync(join(sdk, "node_modules"), { throwIfNoEntry: false })) throw Error("run `npm ci` in runtime/packages/sdk first");
  rmSync(output, { recursive: true, force: true }); rmSync(stampFile, { force: true });
  buildLocalApplication({ stackConfig: stack.configFile, verifier, runtimeFile, outputDirectory: output });
  note("building the local SDK application package");
  // The build's own warnings (esbuild notes on the IIFE bundles) are shown only when it fails.
  const built = spawnSync("npm", ["run", "build"], { cwd: output, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (built.status !== 0) throw Error(`the local SDK application build failed:\n${built.stdout}${built.stderr}`);
  writeFileSync(stampFile, stamp);
  return output;
}
