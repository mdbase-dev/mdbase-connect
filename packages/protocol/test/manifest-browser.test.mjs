import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  parseVersionedAppManifest,
  validateVersionedAppManifest
} from "../dist/manifest.js";

const directory = fileURLToPath(new URL("..", import.meta.url));
const digest = document => `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`;
const document = (version, payload = "") => `---\nkind: mdbase.type\nname: scratch\nversion: ${version}\n---\n${payload}`;
const golden = [
  ["", "b45e38d762b63a78834653e64831583a15a847cbd6792bec10dc37dd7defe1a7"],
  ["abc", "8348f5fd7213117a02000a5a0ad72de9ecb4159c18171b3217789be25a1367e4"],
  ["café 😀 漢字", "6f60598d0a28de4c6c835d7310472b88ca1814d7a464342204fb6bd15bb76cad"],
  ["\ud800", "bda74bf90039089cd60b3bc318ef8b1a8d4b457d95ecf3d4d735938402fff766"]
];
const payloads = [
  ...golden.map(([value]) => value), "\udfff", "a\ud800b\udfffc", "\0a\0",
  "e\u0301", "é", "a\r\nb\n", "\uFEFF", "😀".repeat(64),
  ...[7, 8, 15, 16, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024].map(n => "a".repeat(n))
];
function declaration(version, payload = "") {
  const desired = document(3, payload), baseline = document(1, payload);
  return {
    manifest_version: 1, id: "dev.example.browser", name: "Browser",
    homepage: "https://example.test/", redirect_uris: ["https://example.test/callback"],
    requirements: {
      contracts: [], access: "full_collection",
      capabilities: { contract_version: version, required: version === 1 ? ["records.read", "collection.setup.apply"] : ["collection.read"] }
    },
    provisions: {
      type_packs: [{
        manifest: {
          kind: "mdbase.type-pack", id: "example.scratch", version: "1.0.0",
          resources: [{ kind: "type", mode: "seed", source: "types/scratch.md", target: "_types/scratch.md",
            digest: digest(desired), ...(version === 2 ? { upgrade_from: { digest: digest(baseline), document: baseline, version: 1 } } : {}) }]
        },
        resources: [{ source: "types/scratch.md", document: desired }], provides: []
      }]
    }
  };
}
const resource = value => value.provisions.type_packs[0].manifest.resources[0];
const plain = value => JSON.parse(JSON.stringify(value));

for (const version of [1, 2]) {
  test(`v${version} synchronous document and baseline hashes match Node UTF-8 goldens`, () => {
    for (const [payload, expected] of golden) {
      const input = declaration(version, payload);
      assert.equal(resource(input).digest, `sha256:${expected}`);
      assert.deepEqual(validateVersionedAppManifest(input), { valid: true, issues: [] });
    }
    for (const payload of payloads) {
      const input = declaration(version, payload), original = structuredClone(input);
      const parsed = parseVersionedAppManifest(input);
      assert.equal(parsed.contractVersion, version);
      assert.equal(parsed.manifest.provisions.type_packs[0].resources[0].document, document(3, payload));
      assert.deepEqual(input, original);
      resource(input).digest = `sha256:${"0".repeat(64)}`;
      assert.deepEqual(validateVersionedAppManifest(input), { valid: false, issues: [{
        path: "/provisions/type_packs/0/manifest/resources/0/digest", keyword: "digest",
        message: "does not match the embedded document", params: {}
      }] });
      resource(input).digest = digest(document(3, payload));
      if (version === 2) {
        resource(input).upgrade_from.digest = `sha256:${"0".repeat(64)}`;
        assert.deepEqual(validateVersionedAppManifest(input), { valid: false, issues: [{
          path: "/provisions/type_packs/0/manifest/resources/0/upgrade_from/digest", keyword: "digest",
          message: "does not match the baseline document", params: {}
        }] });
      } else {
        // Predecessor schema never admitted upgrade_from; browser-safe hashing
        // must preserve that rejection, not widen the legacy declaration.
        resource(input).upgrade_from = resource(declaration(2, payload)).upgrade_from;
        assert.deepEqual(validateVersionedAppManifest(input), { valid: false, issues: [{
          path: "/provisions/type_packs/0/manifest/resources/0/upgrade_from", keyword: "additionalProperties",
          message: "is not allowed", params: { additionalProperty: "upgrade_from" }
        }] });
      }
    }
  });
}

test("canonical parser produces real browser ESM without Node imports or hash shims", async () => {
  const result = await build({
    absWorkingDir: directory, entryPoints: ["dist/manifest.js"], bundle: true,
    platform: "browser", format: "esm", write: false, metafile: true
  });
  const outputs = Object.values(result.metafile.outputs);
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0].imports, []);
  assert(!result.outputFiles[0].text.includes("node:crypto"));
  assert(Object.keys(result.metafile.inputs).some(path => path.includes("@noble/hashes") && path.endsWith("/sha2.js")));
});

test("browser-global-only bundle preserves both parser versions and exact invalid-input issues", async () => {
  const result = await build({
    absWorkingDir: directory, entryPoints: ["dist/manifest.js"], bundle: true,
    platform: "browser", format: "iife", globalName: "ManifestParser", write: false, metafile: true
  });
  assert.deepEqual(Object.values(result.metafile.outputs)[0].imports, []);
  const context = createContext({ TextEncoder, TextDecoder, structuredClone, URL, URLSearchParams });
  assert.equal(runInContext("typeof process + ':' + typeof Buffer + ':' + typeof require", context), "undefined:undefined:undefined");
  runInContext(result.outputFiles[0].text, context);
  // Parse each JSON input in the browser realm: the canonical plain-JSON guard
  // intentionally rejects foreign-realm objects. Do not weaken that guard.
  const browser = (method, input) => {
    context.inputJson = JSON.stringify(input);
    return runInContext(`ManifestParser.${method}(JSON.parse(inputJson))`, context);
  };
  for (const version of [1, 2]) {
    for (const payload of payloads) {
      const input = declaration(version, payload);
      assert.deepEqual(plain(browser("parseVersionedAppManifest", input)), parseVersionedAppManifest(input));
      assert.deepEqual(plain(browser("validateVersionedAppManifest", input)), validateVersionedAppManifest(input));
      const invalid = structuredClone(input);
      if (version === 2) resource(invalid).upgrade_from.document += "changed";
      else invalid.provisions.type_packs[0].resources[0].document += "changed";
      const expected = validateVersionedAppManifest(invalid);
      assert.equal(expected.valid, false);
      assert.deepEqual(plain(browser("validateVersionedAppManifest", invalid)), expected);
      assert.throws(() => browser("parseVersionedAppManifest", invalid), error =>
        error.name === "AppManifestValidationError" && JSON.stringify(error.issues) === JSON.stringify(expected.issues));
    }
    const duplicate = declaration(version);
    const baseline = resource(declaration(2)).upgrade_from;
    resource(duplicate).upgrade_from = [baseline, structuredClone(baseline)];
    assert.deepEqual(plain(browser("validateVersionedAppManifest", duplicate)), validateVersionedAppManifest(duplicate));
    const malformed = declaration(version);
    malformed.requirements.capabilities.contract_version = 3;
    assert.deepEqual(plain(browser("validateVersionedAppManifest", malformed)), validateVersionedAppManifest(malformed));
  }
});
