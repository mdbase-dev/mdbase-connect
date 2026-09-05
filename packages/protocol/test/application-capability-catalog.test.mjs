import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  APPLICATION_CAPABILITY_V1_DEFINITIONS,
  APPLICATION_CAPABILITY_V1_CONTRACT_VERSION,
  capabilityOperationsForContractVersion,
  APPLICATION_CAPABILITY_CONTRACT_VERSION,
  APPLICATION_CAPABILITY_DEFINITIONS,
  APPLICATION_SETUP_OPERATIONS,
  applicationOperationSelectionIsAtomic,
  operationsForApplicationCapabilities
} from "../dist/capabilities.js";

const catalog = JSON.parse(readFileSync(
  new URL("../schemas/application-capability-catalog.v2.json", import.meta.url),
  "utf8"
));

// Exact table from c2596a6e:packages/protocol/src/capabilities.ts. Intentionally
// independent of both generated outputs and the input JSON; no git at test time.
const predecessor = {
  "collection.inspect": ["describe"],
  "records.watch": ["changes"],
  "records.read": ["read"],
  "records.query": ["query"],
  "records.validate": ["validate"],
  "records.create": ["create"],
  "records.update": ["update"],
  "records.delete": ["delete"],
  "records.rename": ["rename"],
  "views.list": ["list_views"],
  "views.execute": ["execute_view"],
  "views.source.read": ["read_view_source"],
  "views.source.create": ["create_view_source"],
  "views.source.update": ["update_view_source"],
  "views.source.delete": ["delete_view_source"],
  "definitions.contracts.current": [],
  "definitions.read": ["read_type"],
  "definitions.create": ["create_type"],
  "definitions.update": ["update_type"],
  "definitions.type-pack.inspect": ["assess_type_pack"],
  "definitions.type-pack.apply": ["assess_type_pack", "apply_type_pack"],
  "collection.setup.apply": ["assess_collection_setup", "apply_collection_setup"],
  "timers.list": ["list_timers"],
  "timers.put": ["put_timer"],
  "timers.cancel": ["cancel_timer"],
  "timers.reconcile": ["reconcile_timers"],
  "sync.offline-replica": ["sync"],
  "notifications.background-delivery": [],
  "files.list": [],
  "files.read": [],
  "files.add": [],
  "files.replace": [],
  "files.move": [],
  "files.delete": []
};

const legacyCatalog = JSON.parse(readFileSync(
  new URL("../schemas/application-capability-catalog.v1.json", import.meta.url), "utf8"
));

test("the immutable v1 catalog preserves the complete predecessor table", () => {
  assert.equal(legacyCatalog.catalog_version, 1);
  assert.equal(APPLICATION_CAPABILITY_V1_CONTRACT_VERSION, 1);
  assert.deepEqual(legacyCatalog.capabilities, Object.entries(predecessor).map(
    ([id, operations]) => ({ id, operations })
  ));
  assert.deepEqual(APPLICATION_CAPABILITY_V1_DEFINITIONS, predecessor);
  assert.ok(Object.isFrozen(APPLICATION_CAPABILITY_V1_DEFINITIONS));
  for (const [id, operations] of Object.entries(predecessor)) {
    assert.ok(Object.isFrozen(APPLICATION_CAPABILITY_V1_DEFINITIONS[id]));
    assert.deepEqual(capabilityOperationsForContractVersion(1, id), operations);
  }
});

test("versioned lookup rejects unknown and mixed contracts without falling back", () => {
  for (const version of [0, 3, -1, 1.5, NaN, Infinity, "1", undefined]) {
    assert.equal(capabilityOperationsForContractVersion(version, "records.create"), undefined);
  }
  for (const version of [1, 2]) {
    for (const id of ["unknown", "", "toString", "constructor", "__proto__"]) {
      assert.equal(capabilityOperationsForContractVersion(version, id), undefined);
    }
    // Shared IDs are legitimate in each version; neither catalog is a fallback.
    assert.deepEqual(capabilityOperationsForContractVersion(version, "records.create"), ["create"]);
    assert.deepEqual(capabilityOperationsForContractVersion(version, "records.delete"), ["delete"]);
  }
  assert.equal(capabilityOperationsForContractVersion(1, "records.edit"), undefined);
  assert.equal(capabilityOperationsForContractVersion(2, "records.update"), undefined);
  assert.equal(capabilityOperationsForContractVersion(2, "files.read"), undefined);
  assert.deepEqual(capabilityOperationsForContractVersion(1, "files.read"), []);
  const copy = capabilityOperationsForContractVersion(1, "records.update");
  copy.push("delete");
  assert.deepEqual(capabilityOperationsForContractVersion(1, "records.update"), ["update"]);
  for (const { id, operations } of catalog.capabilities) {
    assert.deepEqual(capabilityOperationsForContractVersion(2, id), operations);
  }
});

test("both generated catalogs are current", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL(
    "../../../scripts/generate-application-capabilities.mjs", import.meta.url
  )), "--check"]);
});

test("generated Rust compiles and resolves both catalogs exactly like TypeScript", () => {
  const directory = mkdtempSync(join(tmpdir(), "capability-catalog-"));
  try {
    const rust = fileURLToPath(new URL(
      "../../../crates/connect-protocol/src/application_capabilities_generated.rs", import.meta.url
    ));
    const assertions = [
      `assert_eq!(APPLICATION_CAPABILITY_CONTRACT_VERSION, 2);`,
      `assert_eq!(APPLICATION_CAPABILITY_V1_CONTRACT_VERSION, 1);`
    ];
    for (const [version, definitions] of [[1, predecessor], [2, APPLICATION_CAPABILITY_DEFINITIONS]]) {
      const ids = Object.keys(definitions);
      assertions.push(`assert_eq!(${version === 1 ? "APPLICATION_CAPABILITY_V1_IDS" : "APPLICATION_CAPABILITY_IDS"}, &[${ids.map(JSON.stringify).join(",")}]);`);
      for (const [id, operations] of Object.entries(definitions)) {
        assertions.push(`assert_eq!(application_capability_operations_for_contract_version(${version}, ${JSON.stringify(id)}), Some(&[${operations.map(JSON.stringify).join(",")}] as &[&str]));`);
      }
      for (const id of [...Object.keys(predecessor), ...Object.keys(APPLICATION_CAPABILITY_DEFINITIONS), "unknown", "__proto__", ""]) {
        if (!Object.hasOwn(definitions, id)) {
          assertions.push(`assert_eq!(application_capability_operations_for_contract_version(${version}, ${JSON.stringify(id)}), None);`);
        }
      }
    }
    for (const version of [0, 3, 4294967295]) {
      assertions.push(`assert_eq!(application_capability_operations_for_contract_version(${version}, "records.create"), None);`);
    }
    const source = join(directory, "check.rs");
    const binary = join(directory, "check");
    writeFileSync(source, `include!(${JSON.stringify(rust)});\nfn main() {\n${assertions.join("\n")}\n}\n`);
    execFileSync("rustc", ["--edition=2021", source, "-o", binary]);
    execFileSync(binary);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the generated application capability contract matches its canonical catalog", () => {
  assert.equal(APPLICATION_CAPABILITY_CONTRACT_VERSION, 2);
  assert.deepEqual(
    Object.entries(APPLICATION_CAPABILITY_DEFINITIONS),
    catalog.capabilities.map(({ id, operations }) => [id, operations])
  );
  assert.deepEqual(
    [...APPLICATION_SETUP_OPERATIONS],
    catalog.structured_authorities.application_setup
  );
});

test("application capabilities compile only complete atomic groups", () => {
  assert.deepEqual(
    operationsForApplicationCapabilities({
      contract_version: 2,
      required: ["records.edit"],
      optional: ["records.delete"]
    }, { includeOptional: false }),
    ["update", "rename"]
  );
  const requirements = {
    contract_version: 2,
    required: ["records.edit"],
    optional: ["records.delete"]
  };
  assert.deepEqual(
    operationsForApplicationCapabilities(requirements),
    ["update", "rename", "delete"]
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update", "rename"]),
    true
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update"]),
    false
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update", "rename", "delete"]),
    true
  );
  assert.equal(
    applicationOperationSelectionIsAtomic(requirements, ["update", "rename", "create"]),
    false
  );
});
