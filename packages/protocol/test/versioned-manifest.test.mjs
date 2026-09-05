import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { canonicalMutationInput } from "../dist/index.js";
import {
  AppManifestValidationError,
  parseAppManifest,
  parseVersionedAppManifest,
  validateAppManifest,
  validateVersionedAppManifest
} from "../dist/manifest.js";

function manifest(version = 1) {
  return {
    manifest_version: 1, id: "dev.example.legacy", name: "Legacy",
    homepage: "https://example.test/", redirect_uris: ["https://example.test/callback"],
    requirements: {
      access: "full_collection", contracts: [],
      capabilities: { contract_version: version, required: [version === 1 ? "records.read" : "collection.read"] }
    }
  };
}
const digest = (value) => createHash("sha256").update(canonicalMutationInput(value)).digest("hex");

test("versioned parsing preserves predecessor normalization and canonical digest without translation", () => {
  const input = manifest();
  input.requirements.files = { actions: ["read"], scope: { kind: "collection" } };
  input.requirements.capabilities.optional = ["files.read"];
  // Exact predecessor normalization: defaults only; aliases/version remain untouched.
  const predecessor = {
    ...input,
    requirements: { configuration: [], ...input.requirements },
    provisions: { type_packs: [], configuration: [] }, notifications: { criteria: [] }
  };
  const original = structuredClone(input);
  const parsed = parseVersionedAppManifest(input);
  assert.equal(parsed.contractVersion, 1);
  assert.deepEqual(parsed.manifest, predecessor);
  assert.equal(digest(parsed.manifest), digest(predecessor));
  assert.equal(digest(parsed.manifest), "471b4d07e2edabb329886d4beb3e6b80c23c068583bb5ef650d7a428a83ee82a");
  assert.deepEqual(input, original);
  parsed.manifest.requirements.files.actions.push("list");
  assert.deepEqual(input, original);
  assert.equal(validateAppManifest(input).valid, false);
  assert.throws(() => parseAppManifest(input), AppManifestValidationError);
});

test("only capability declaration selects version; absence is v1 and malformed/unknown versions fail", () => {
  const absent = manifest();
  delete absent.requirements.capabilities;
  absent.requirements.files = { actions: ["read"], scope: { kind: "collection" } };
  assert.equal(parseVersionedAppManifest(absent).contractVersion, 1);
  assert.equal(parseVersionedAppManifest(absent).manifest.requirements.capabilities, undefined);
  for (const version of [0, 3, "1", null, undefined]) {
    const input = manifest();
    input.requirements.capabilities.contract_version = version;
    assert.equal(validateVersionedAppManifest(input).valid, false);
    assert.throws(() => parseVersionedAppManifest(input), AppManifestValidationError);
  }
  for (const capabilities of [null, {}, [], "v2"]) {
    assert.equal(validateVersionedAppManifest({ ...manifest(), requirements: { ...manifest().requirements, capabilities } }).valid, false);
  }
});

test("version-specific IDs and file declaration shapes cannot be mixed", () => {
  for (const version of [1, 2]) {
    const input = manifest(version);
    input.requirements.capabilities.required = [version === 1 ? "collection.read" : "records.read"];
    assert.equal(validateVersionedAppManifest(input).valid, false);
    input.requirements.capabilities.required = [version === 1 ? "records.read" : "collection.read"];
    input.requirements.files = { scope: { kind: "collection" }, [version === 1 ? "required" : "actions"]: ["read"] };
    assert.equal(validateVersionedAppManifest(input).valid, false);
  }
  const noVersion = manifest();
  delete noVersion.requirements.capabilities;
  noVersion.requirements.files = { required: ["read"], scope: { kind: "collection" } };
  assert.equal(validateVersionedAppManifest(noVersion).valid, false);
});

test("predecessor aliases pair every action in required or optional and enforce both directions", () => {
  for (const action of ["list", "read", "add", "replace", "move", "delete"]) {
    for (const section of ["required", "optional"]) {
      const input = manifest();
      input.requirements.capabilities[section] = [`files.${action}`];
      input.requirements.files = { actions: [action], scope: { kind: "selected_folders", folders: ["assets"] } };
      assert.equal(validateVersionedAppManifest(input).valid, true);
      const missingFile = structuredClone(input);
      delete missingFile.requirements.files;
      assert.equal(validateVersionedAppManifest(missingFile).valid, false);
      input.requirements.capabilities[section] = [];
      assert.equal(validateVersionedAppManifest(input).valid, false);
    }
  }
});

test("both versions retain distribution and local-origin rules", () => {
  for (const version of [1, 2]) {
    for (const distribution of [undefined, "web", "portable"]) {
      const input = manifest(version);
      if (distribution) input.distribution = distribution;
      if (distribution === "portable") {
        delete input.homepage;
        delete input.redirect_uris;
        input.project_url = "https://example.test/project";
      }
      assert.equal(parseVersionedAppManifest(input).contractVersion, version);
      if (version === 2) {
        assert.deepEqual(parseVersionedAppManifest(input).manifest, parseAppManifest(input));
        input.requirements.files = { required: ["read"], optional: ["add"], scope: { kind: "collection" } };
        assert.equal(validateVersionedAppManifest(input).valid, true);
        input.requirements.files.optional = ["read"];
        assert.equal(validateVersionedAppManifest(input).valid, false);
        delete input.requirements.files;
      }
      const local = structuredClone(input);
      if (distribution === "portable") {
        local.project_url = "http://localhost/project";
        assert.equal(validateVersionedAppManifest(local, { allowLocal: true }).valid, false);
      } else {
        local.homepage = "http://localhost:1234/";
        local.redirect_uris = ["http://localhost:1234/callback"];
        assert.equal(validateVersionedAppManifest(local).valid, false);
        assert.equal(validateVersionedAppManifest(local, { allowLocal: true }).valid, true);
        local.redirect_uris = ["https://other.example/callback"];
        assert.equal(validateVersionedAppManifest(local, { allowLocal: true }).valid, false);
      }
      input.icon = "https://other.example/icon.png";
      assert.equal(validateVersionedAppManifest(input).valid, false);
    }
  }
});

test("shared bounds and cross-field checks apply independently of version", () => {
  for (const version of [1, 2]) {
    const input = manifest(version);
    assert.equal(validateVersionedAppManifest(input, { maxBytes: 1 }).valid, false);
    input.requirements.configuration = [{ id: "test", path: "/x-test/value", predicate: "contains", value: "a" }];
    assert.equal(validateVersionedAppManifest(input).valid, false);
    input.provisions = { type_packs: [], configuration: [{ requirement: "test", operation: "set_add", path: "/x-test/value", value: "a" }] };
    if (version === 1) input.requirements.capabilities.required.push("collection.setup.apply");
    assert.equal(validateVersionedAppManifest(input).valid, true);
    input.provisions.configuration[0].value = "b";
    assert.equal(validateVersionedAppManifest(input).valid, false);
  }
  const circular = manifest();
  circular.self = circular;
  assert.equal(validateVersionedAppManifest(circular).valid, false);
});

test("predecessor setup and notification intent rules are not replaced by v2 rules", () => {
  for (const id of ["collection.setup.apply", "notifications.background-delivery"]) {
    const input = manifest();
    input.requirements.capabilities.required = [id];
    assert.equal(validateVersionedAppManifest(input).valid, false);
  }
  const input = manifest();
  input.requirements.capabilities.required.push("notifications.background-delivery");
  input.notifications = { criteria: [] };
  assert.equal(validateVersionedAppManifest(input).valid, true);
  input.requirements.capabilities.optional = ["records.read"];
  assert.equal(validateVersionedAppManifest(input).valid, false);
});

test("legacy schema has an independent ID and frozen contract version", async () => {
  const legacy = JSON.parse(await readFile(new URL("../schemas/mdbase-app.legacy-v1.schema.json", import.meta.url), "utf8"));
  const current = JSON.parse(await readFile(new URL("../schemas/mdbase-app.schema.json", import.meta.url), "utf8"));
  assert.notEqual(legacy.$id, current.$id);
  assert.equal(legacy.$defs.capabilityRequirements.properties.contract_version.const, 1);
  assert.equal(current.$defs.capabilityRequirements.properties.contract_version.const, 2);
});
