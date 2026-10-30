import {test, expect} from "vitest";
import {mkdtempSync, mkdirSync, chmodSync, writeFileSync, existsSync, rmSync, readFileSync} from "node:fs";
import {resolve, join, dirname} from "node:path";
import {createHash, generateKeyPairSync} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
// @ts-expect-error plain build-only .mjs has no declarations
import {buildLocalApplication} from "../scripts/build-local-application.mjs";

for (const refusal of ["managed", "unprotected", "external-credentials", "existing-output"])
  test(`local SDK builder refuses ${refusal} before private inputs or overlay`, () => {
    const parent = resolve(".local-application-build-tests");
    mkdirSync(parent, {recursive: true, mode: 0o700});
    const directory = mkdtempSync(join(parent, "stack-"));
    try {
      chmodSync(directory, refusal === "unprotected" ? 0o755 : 0o700);
      const stackConfig = join(directory, "local-stack.json"), outputDirectory = join(directory, "output");
      writeFileSync(stackConfig, JSON.stringify({environment: refusal === "managed" ? "lab" : "local",
        connectEnvFile: join(directory, refusal === "external-credentials" ? "wrong.json" : "job-env.json")}));
      if (refusal === "existing-output") mkdirSync(outputDirectory);
      expect(() => buildLocalApplication({stackConfig, outputDirectory, verifier: "never-run", runtimeFile: "never-read"})).toThrow("local SDK application build refused");
      expect(existsSync(outputDirectory)).toBe(refusal === "existing-output");
    } finally { rmSync(directory, {recursive: true}); }
  });

test("local SDK builder packages the local runtime under the name its selector loads", () => {
  // The output must sit outside the SDK package, so use the runtime target dir.
  const target = resolve(dirname(fileURLToPath(import.meta.url)), "../../../target");
  mkdirSync(target, {recursive: true});
  const directory = mkdtempSync(join(target, "local-application-build-"));
  try {
    chmodSync(directory, 0o700);
    const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    const cpOrigin = "http://127.0.0.1:8111", logOrigin = "http://127.0.0.1:8222", revision = "bb".repeat(20);
    const stackConfig = join(directory, "local-stack.json"), outputDirectory = join(directory, "output");
    writeFileSync(stackConfig, JSON.stringify({environment: "local", connectEnvFile: join(directory, "job-env.json"), connectOrigin: cpOrigin, logOrigin, revision}));
    writeFileSync(join(directory, "job-env.json"), JSON.stringify({MDBASE_NEXT_ROOT_PUBLIC_KEY: "ab".repeat(32)}));
    const trust = "local trust asset (test stub)";
    writeFileSync(join(directory, "local-trust.json"), trust);
    writeFileSync(join(directory, "local-root.pem"), generateKeyPairSync("ed25519").privateKey.export({type: "pkcs8", format: "pem"}));
    // TEST contract stub for the local verifier; it echoes a normalized trust value.
    const normalized = {schema: "mdbn-trust/normalized/1", environment: "local", control_plane_origin: cpOrigin, log_origin: logOrigin, asset_sha256: sha(trust),
      source: {repository: "mdbase-dev/mdbase-connect", commit: revision, version: "local"}, roots: ["cd".repeat(32)], policy_pins_cbor_hex: "a0"};
    const verifier = join(directory, "verifier.mjs");
    writeFileSync(verifier, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(normalized) + "\n")});`);
    chmodSync(verifier, 0o755);
    const runtime = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), Buffer.from("local runtime")]);
    const runtimeFile = join(directory, "runtime.wasm");
    writeFileSync(runtimeFile, runtime);

    const built = buildLocalApplication({stackConfig, verifier, runtimeFile, outputDirectory});
    expect(built.runtimeSha256).toBe(sha(runtime));
    const selector = readFileSync(join(outputDirectory, "src/application/packaged-assets.ts"), "utf8");
    expect(selector).toContain('new URL("../native/runtime-local.wasm",import.meta.url)');
    expect(selector).not.toContain('"../native/runtime.wasm"');
    expect(readFileSync(join(outputDirectory, "src/native/runtime-local.wasm")).equals(runtime)).toBe(true);
    expect(existsSync(join(outputDirectory, "src/native/runtime.wasm"))).toBe(false);
    // The generated packaging step copies the same file the selector loads.
    execFileSync(process.execPath, [join(outputDirectory, "scripts/package-local-assets.mjs")]);
    expect(readFileSync(join(outputDirectory, "dist/native/runtime-local.wasm")).equals(runtime)).toBe(true);
    expect(existsSync(join(outputDirectory, "dist/native/sqlite3-opfs-async-proxy.js"))).toBe(true);
    expect(existsSync(join(outputDirectory, "dist/native/provenance.local.json"))).toBe(true);
  } finally { rmSync(directory, {recursive: true}); }
});
