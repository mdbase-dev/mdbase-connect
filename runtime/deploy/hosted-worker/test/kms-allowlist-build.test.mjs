// BUILD contract for the bundled KMS allowlist: manifest-pinned digests, the
// cumulative rule with an explicit retire list, create-only output, and the
// fixed deploy alias that refuses bundling without the generated module.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const { build } = createRequire(import.meta.url)("esbuild");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ids = (count, offset = 0) => Array.from({ length: count }, (_, i) => {
  const h = (i + offset + 1).toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-abcd-4000-8000-${h}`;
});
const canonical = (list) => [...new Set(list)].sort().map(x => x + "\n").join("");
const sha = (text) => createHash("sha256").update(text, "latin1").digest("hex");

test("allowlist build: digest-pinned, cumulative unless a retire list names the removal, create-only", async () => {
  // Owned repository-local temp workspace, not /tmp; no deploy/provider effects.
  const d = mkdtempSync(join(root, ".kms-allowlist-build-test-"));
  try {
    mkdirSync(join(d, "src/custody"), { recursive: true });
    writeFileSync(join(d, "build-kms-allowlist.mjs"), readFileSync(join(root, "build-kms-allowlist.mjs")));
    writeFileSync(join(d, "src/custody/kms-allowlist.ts"), readFileSync(join(root, "src/custody/kms-allowlist.ts")));
    symlinkSync(join(root, "node_modules"), join(d, "node_modules"));
    const output = join(d, ".generated/kms-collections.ts");
    const list = (name, values) => { const text = canonical(values); writeFileSync(join(d, name), text); return { file: join(d, name), sha256: sha(text) }; };
    const run = (...args) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(d, "build-kms-allowlist.mjs"), ...args], { encoding: "utf8" });
    const refused = (result, code) => {
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      if (code) assert.match(result.stderr, new RegExp(code));
      assert.equal(existsSync(output), false, "a refused build writes nothing");
    };

    const entry = join(d, "entry.ts");
    writeFileSync(entry, 'import{kmsCollections}from"#hosted-kms-collections";export const bundle=kmsCollections();');
    const bundle = () => build({ entryPoints: [entry], bundle: true, write: false, platform: "neutral", alias: { "#hosted-kms-collections": output }, logLevel: "silent" });
    await assert.rejects(bundle(), "missing generated allowlist must not fall back to the secret-only source default");

    const first = list("first.txt", ids(1_000));
    const second = list("second.txt", ids(1_200));
    const shrunk = list("shrunk.txt", [...ids(999, 1), ...ids(10, 5_000)]);
    const retire = list("retire.txt", ids(1));
    const unsorted = join(d, "unsorted.txt"); writeFileSync(unsorted, ids(3).reverse().map(x => x + "\n").join(""));

    // Usage: the previous allowlist (or an explicit --initial) is mandatory.
    refused(run("--collections", first.file, "--sha256", first.sha256));
    refused(run("--collections", first.file, "--sha256", first.sha256, "--initial", "--previous", first.file, "--previous-sha256", first.sha256));
    refused(run("--collections", first.file, "--sha256", first.sha256, "--initial", "--retire", retire.file, "--retire-sha256", retire.sha256));
    refused(run("--collections", first.file, "--sha256", first.sha256, "--previous", first.file));
    // Digest mismatch and non-canonical input refuse.
    refused(run("--collections", first.file, "--sha256", second.sha256, "--initial"), "kms_allowlist_digest_mismatch");
    refused(run("--collections", second.file, "--sha256", second.sha256, "--previous", first.file, "--previous-sha256", second.sha256), "kms_allowlist_digest_mismatch");
    refused(run("--collections", unsorted, "--sha256", sha(readFileSync(unsorted, "latin1")), "--initial"), "kms_allowlist_invalid");
    // Shrinking refuses without the retire input; a bad retire list refuses too.
    refused(run("--collections", shrunk.file, "--sha256", shrunk.sha256, "--previous", first.file, "--previous-sha256", first.sha256), "kms_allowlist_shrinks");
    refused(run("--collections", second.file, "--sha256", second.sha256, "--previous", first.file, "--previous-sha256", first.sha256,
      "--retire", retire.file, "--retire-sha256", retire.sha256), "kms_allowlist_retire_still_served");

    // Explicit retire: accepted, and the receipt records it.
    const retired = run("--collections", shrunk.file, "--sha256", shrunk.sha256, "--previous", first.file, "--previous-sha256", first.sha256,
      "--retire", retire.file, "--retire-sha256", retire.sha256);
    assert.equal(retired.status, 0, retired.stderr);
    assert.deepEqual(JSON.parse(retired.stdout), { schema: "mdbn-hosted-kms-collections/1", sha256: shrunk.sha256, count: 1_009,
      previous_sha256: first.sha256, retire_sha256: retire.sha256, added: 10, retired: 1 });
    rmSync(output);

    // Growing 1,000 -> 1,200 is accepted; output is create-only.
    const grown = run("--collections", second.file, "--sha256", second.sha256, "--previous", first.file, "--previous-sha256", first.sha256);
    assert.equal(grown.status, 0, grown.stderr);
    assert.deepEqual(JSON.parse(grown.stdout), { schema: "mdbn-hosted-kms-collections/1", sha256: second.sha256, count: 1_200,
      previous_sha256: first.sha256, retire_sha256: null, added: 200, retired: 0 });
    const original = readFileSync(output);
    assert.notEqual(run("--collections", second.file, "--sha256", second.sha256, "--previous", first.file, "--previous-sha256", first.sha256).status, 0, "no overwrite");
    assert.deepEqual(readFileSync(output), original);

    // The generated module bundles and verifies against the pinned digest.
    const compiled = await bundle();
    assert.match(compiled.outputFiles[0].text, new RegExp(second.sha256));
    const { kmsCollections } = await import(pathToFileURL(output).href);
    const { deploymentKmsAllowlist } = await import(pathToFileURL(join(root, "src/custody/kms-allowlist.ts")).href);
    const allowlist = deploymentKmsAllowlist(kmsCollections(), second.sha256, undefined);
    assert.equal(allowlist.size, 1_200);
    assert.ok(allowlist.has(ids(1, 1_199)[0]));
    assert.equal(allowlist.has(ids(1, 1_200)[0]), false);
    assert.throws(() => deploymentKmsAllowlist(kmsCollections(), first.sha256, undefined), /kms_allowlist_digest_mismatch/);

    assert.match(readFileSync(join(root, "wrangler.jsonc"), "utf8"), /"#hosted-kms-collections": "\.\/\.generated\/kms-collections\.ts"/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
