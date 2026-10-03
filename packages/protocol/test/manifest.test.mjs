import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  APPLICATION_CAPABILITY_CONTRACT_VERSION,
  APPLICATION_CAPABILITY_DEFINITIONS
} from "../dist/index.js";
import {
  AppManifestValidationError,
  parseAppManifest,
  validateAppManifest
} from "../dist/manifest.js";

const document = "---\nkind: mdbase.type\nname: scratch\nversion: 1\n---\n";
const digest = `sha256:${createHash("sha256").update(document).digest("hex")}`;

function manifest() {
  return {
    manifest_version: 1,
    id: "dev.example.tasks",
    name: "Tasks",
    homepage: "https://tasks.example/",
    icon: "https://tasks.example/icon.png",
    redirect_uris: [
      "https://tasks.example/auth/mdbase/callback",
      "dev.example.tasks://auth/mdbase/callback"
    ],
    requirements: {
      contracts: [],
      capabilities: {
        contract_version: 2,
        required: ["collection.read"],
        optional: ["records.create"]
      },
      access: "full_collection"
    },
    provisions: {
      type_packs: [{
        manifest: {
          kind: "mdbase.type-pack",
          id: "example.scratch",
          version: "1.0.0",
          resources: [{
            kind: "type",
            mode: "seed",
            source: "types/scratch.md",
            target: "_types/scratch.md",
            digest
          }]
        },
        resources: [{ source: "types/scratch.md", document }],
        provides: []
      }]
    }
  };
}

test("semantic capabilities and provision ownership share one canonical validator", () => {
  assert.deepEqual(validateAppManifest(manifest()), { valid: true, issues: [] });

  const invalid = manifest();
  delete invalid.provisions.type_packs[0].manifest.resources[0].mode;
  const result = validateAppManifest(invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues[0], {
    path: "/provisions/type_packs/0/manifest/resources/0/mode",
    keyword: "required",
    message: "is required",
    params: { missingProperty: "mode" }
  });
  assert.throws(
    () => parseAppManifest(invalid),
    (error) => error instanceof AppManifestValidationError
      && error.message.includes(
        "/provisions/type_packs/0/manifest/resources/0/mode is required"
      )
  );
});

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function starter(version, extra = "") {
  const text = `---\nkind: mdbase.type\nname: scratch\nversion: ${version}\n${extra}---\n`;
  return { digest: sha256(text), document: text };
}

function upgradeManifest(upgradeFrom) {
  const value = manifest();
  const desired = starter(3);
  const pack = value.provisions.type_packs[0];
  Object.assign(pack.manifest.resources[0], { digest: desired.digest, upgrade_from: upgradeFrom });
  pack.resources[0].document = desired.document;
  return value;
}

function issuesOf(value) {
  const result = validateAppManifest(value);
  return result.valid ? [] : result.issues.map(({ path, keyword }) => `${keyword} ${path}`);
}

const upgradePath = "/provisions/type_packs/0/manifest/resources/0/upgrade_from";

test("seed upgrades retain a single exact reviewed baseline and reject tampering", () => {
  const baseline = starter(2);
  const value = upgradeManifest({ ...baseline });
  assert.deepEqual(validateAppManifest(value), { valid: true, issues: [] });
  assert.deepEqual(parseAppManifest(value).provisions.type_packs[0].manifest.resources[0].upgrade_from, baseline);
  const resource = value.provisions.type_packs[0].manifest.resources[0];
  resource.upgrade_from.document += "changed";
  assert.deepEqual(issuesOf(value), [`digest ${upgradePath}/digest`]);
  resource.upgrade_from.document = baseline.document;
  resource.mode = "managed";
  assert.deepEqual(issuesOf(value), [`seedUpgrade ${upgradePath}`]);
});

test("seed upgrades accept a non-empty list of distinct earlier starters", () => {
  const list = [{ ...starter(1), version: 1 }, starter(2, "description: second\n")];
  const value = upgradeManifest(list);
  assert.deepEqual(validateAppManifest(value), { valid: true, issues: [] });
  assert.deepEqual(parseAppManifest(value).provisions.type_packs[0].manifest.resources[0].upgrade_from, list);
  assert.ok(issuesOf(upgradeManifest([])).some((entry) => entry.startsWith("minItems ")));
});

test("seed upgrade baselines may use YAML anchors without alias expansion", () => {
  // TaskNotes' first task starter reuses an enum through an anchor.
  const anchored = starter(1, "schema:\n  value:\n    properties:\n      status: { enum: &a1 [open, done] }\n      next: { enum: *a1 }\n");
  const value = upgradeManifest([anchored, starter(2)]);
  assert.deepEqual(validateAppManifest(value), { valid: true, issues: [] });
  assert.deepEqual(issuesOf(upgradeManifest([{ ...anchored, version: 2 }])), [`seedUpgrade ${upgradePath}/0/version`]);
});

test("seed upgrade baselines are rejected with the offending baseline's path", () => {
  const first = starter(1);
  const second = starter(2);
  const desired = starter(3);
  const cases = [
    [[first, { ...second, document: `${second.document}changed` }], `digest ${upgradePath}/1/digest`],
    [[first, second, first], `uniqueBaseline ${upgradePath}/2/digest`],
    [[first, desired], `seedUpgrade ${upgradePath}/1/digest`],
    [[first, { ...second, version: 1 }], `seedUpgrade ${upgradePath}/1/version`]
  ];
  for (const [upgradeFrom, expected] of cases) {
    assert.deepEqual(issuesOf(upgradeManifest(upgradeFrom)), [expected]);
  }
  for (const document of [
    "---\nkind: mdbase.type\nname: other\nversion: 2\n---\n",
    "---\nkind: mdbase.contract\nname: scratch\nversion: 2\n---\n",
    "no frontmatter\n"
  ]) {
    assert.deepEqual(
      issuesOf(upgradeManifest([first, { digest: sha256(document), document }])),
      [`seedUpgrade ${upgradePath}/1/document`]
    );
  }
  const managed = upgradeManifest([first]);
  managed.provisions.type_packs[0].manifest.resources[0].kind = "schema";
  assert.deepEqual(issuesOf(managed), [`seedUpgrade ${upgradePath}`]);
});

test("legacy contract-scoped declarations are rejected rather than widened", () => {
  const scoped = manifest();
  scoped.requirements.access = "contract";
  const result = validateAppManifest(scoped);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) =>
    issue.path === "/requirements/access"
    && ["const", "collectionAccess"].includes(issue.keyword)
  ));
  assert.throws(
    () => parseAppManifest(scoped),
    (error) => error instanceof AppManifestValidationError
      && error.message.includes("/requirements/access")
  );

  const omitted = manifest();
  delete omitted.requirements.access;
  const omittedResult = validateAppManifest(omitted);
  assert.equal(omittedResult.valid, false);
  assert.ok(omittedResult.issues.some((issue) =>
    issue.path === "/requirements/access"
    && ["required", "collectionAccess"].includes(issue.keyword)
  ));
  assert.throws(
    () => parseAppManifest(omitted),
    (error) => error instanceof AppManifestValidationError
      && error.message.includes("/requirements/access")
  );
});

test("setup provisions and ongoing definition management are independent", () => {
  const setupOnly = manifest();
  assert.deepEqual(validateAppManifest(setupOnly), { valid: true, issues: [] });

  const editor = manifest();
  editor.provisions.type_packs = [];
  editor.requirements.capabilities.required = [
    "collection.read",
    "definitions.manage"
  ];
  assert.deepEqual(validateAppManifest(editor), { valid: true, issues: [] });
});

test("portable declarations validate without inventing a web origin", () => {
  assert.deepEqual(validateAppManifest({
    manifest_version: 1,
    distribution: "portable",
    id: "dev.example.portable",
    name: "Portable app",
    project_url: "https://portable.example/project",
    icon: "https://portable.example/icon.png",
    requirements: { access: "full_collection", contracts: [] }
  }), { valid: true, issues: [] });

  const parsed = parseAppManifest({
    manifest_version: 1,
    distribution: "portable",
    id: "dev.example.portable",
    name: "Portable app",
    requirements: { access: "full_collection", contracts: [] }
  });
  assert.deepEqual(parsed.requirements, {
    access: "full_collection",
    contracts: [],
    configuration: []
  });
  assert.deepEqual(parsed.provisions, { type_packs: [], configuration: [] });
  assert.deepEqual(parsed.notifications, { criteria: [] });
});

test("semantic diagnostics expose exact paths", () => {
  const invalid = manifest();
  invalid.requirements.capabilities.optional = ["collection.read"];
  invalid.provisions.type_packs[0].manifest.resources[0].digest =
    `sha256:${"0".repeat(64)}`;
  const result = validateAppManifest(invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map(({ path, keyword }) => ({ path, keyword })),
    [
      { path: "/requirements/capabilities/optional", keyword: "disjoint" },
      {
        path: "/provisions/type_packs/0/manifest/resources/0/digest",
        keyword: "digest"
      }
    ]
  );
});

test("the published schema capability catalogue matches the executable contract", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../schemas/mdbase-app.schema.json", import.meta.url),
    "utf8"
  ));
  assert.equal(
    schema.$defs.capabilityRequirements.properties.contract_version.const,
    APPLICATION_CAPABILITY_CONTRACT_VERSION
  );
  assert.deepEqual(
    schema.$defs.applicationCapability.enum,
    Object.keys(APPLICATION_CAPABILITY_DEFINITIONS)
  );
});

test("the complete declaration has one shared UTF-8 size bound", () => {
  const result = validateAppManifest(manifest(), { maxBytes: 10 });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].keyword, "maxBytes");
  assert.equal(result.issues[0].path, "/");
});

test("runtime callers cannot smuggle non-JSON values through extension fields", () => {
  const invalid = manifest();
  invalid.provisions.type_packs[0].manifest["x-example"] = () => "omitted";
  const result = validateAppManifest(invalid);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map(({ path, keyword }) => ({ path, keyword })),
    [{ path: "/provisions/type_packs/0/manifest/x-example", keyword: "json" }]
  );
});

test("configuration requirements are pointer-safe and exactly provisioned", () => {
  const declaration = manifest();
  declaration.requirements.configuration = [{
    id: "tasknotes-base-sources",
    path: "/x-obsidian/bases/include",
    predicate: "contains",
    value: "views/tasknotes/**/*.base"
  }];
  declaration.provisions.configuration = [{
    requirement: "tasknotes-base-sources",
    operation: "set_add",
    path: "/x-obsidian/bases/include",
    value: "views/tasknotes/**/*.base"
  }];
  assert.deepEqual(validateAppManifest(declaration), { valid: true, issues: [] });

  const corePath = structuredClone(declaration);
  corePath.requirements.configuration[0].path = "/settings/validation/include";
  corePath.provisions.configuration[0].path = "/settings/validation/include";
  const coreResult = validateAppManifest(corePath);
  assert.equal(coreResult.valid, false);
  assert.ok(coreResult.issues.some((issue) =>
    issue.path === "/requirements/configuration/0/path"
    && issue.keyword === "configurationPointer"
  ));

  const recordExtensions = structuredClone(declaration);
  for (const configuration of [
    recordExtensions.requirements.configuration[0],
    recordExtensions.provisions.configuration[0]
  ]) {
    configuration.path = "/settings/record_extensions";
    configuration.value = "base";
  }
  assert.deepEqual(validateAppManifest(recordExtensions), { valid: true, issues: [] });
  recordExtensions.requirements.configuration[0].value = "txt";
  recordExtensions.provisions.configuration[0].value = "txt";
  const extensionResult = validateAppManifest(recordExtensions);
  assert.equal(extensionResult.valid, false);
  assert.ok(extensionResult.issues.some((issue) =>
    issue.path === "/requirements/configuration/0/path"
    && issue.keyword === "configurationPointer"
  ));

  const mismatched = structuredClone(declaration);
  mismatched.provisions.configuration[0].value = "other/**/*.base";
  const mismatchResult = validateAppManifest(mismatched);
  assert.equal(mismatchResult.valid, false);
  assert.ok(mismatchResult.issues.some((issue) =>
    issue.path === "/provisions/configuration/0/value"
    && issue.keyword === "configurationRequirement"
  ));
});
