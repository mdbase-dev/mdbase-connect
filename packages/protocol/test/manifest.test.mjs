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
        contract_version: 1,
        required: ["collection.inspect", "collection.setup.apply"],
        optional: ["records.query"]
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

test("generic editors may apply user-selected packs without bundling one", () => {
  const editor = manifest();
  editor.provisions.type_packs = [];
  editor.requirements.capabilities.required = [
    "collection.inspect",
    "definitions.type-pack.apply"
  ];
  assert.deepEqual(validateAppManifest(editor), { valid: true, issues: [] });

  const missingCapability = manifest();
  missingCapability.requirements.capabilities.required = ["collection.inspect"];
  const result = validateAppManifest(missingCapability);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) =>
    issue.path === "/requirements/capabilities/required"
    && issue.keyword === "collectionSetupCapability"
  ));
});

test("portable declarations validate without inventing a web origin", () => {
  assert.deepEqual(validateAppManifest({
    manifest_version: 1,
    distribution: "portable",
    id: "dev.example.portable",
    name: "Portable app",
    project_url: "https://portable.example/project",
    icon: "https://portable.example/icon.png"
  }), { valid: true, issues: [] });

  const parsed = parseAppManifest({
    manifest_version: 1,
    distribution: "portable",
    id: "dev.example.portable",
    name: "Portable app"
  });
  assert.deepEqual(parsed.requirements, { contracts: [], configuration: [] });
  assert.deepEqual(parsed.provisions, { type_packs: [], configuration: [] });
  assert.deepEqual(parsed.notifications, { criteria: [] });
});

test("semantic diagnostics expose exact paths", () => {
  const invalid = manifest();
  invalid.requirements.capabilities.optional = ["collection.inspect"];
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

  const mismatched = structuredClone(declaration);
  mismatched.provisions.configuration[0].value = "other/**/*.base";
  const mismatchResult = validateAppManifest(mismatched);
  assert.equal(mismatchResult.valid, false);
  assert.ok(mismatchResult.issues.some((issue) =>
    issue.path === "/provisions/configuration/0/value"
    && issue.keyword === "configurationRequirement"
  ));
});
