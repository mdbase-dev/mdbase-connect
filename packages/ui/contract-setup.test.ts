import assert from "node:assert/strict";
import test from "node:test";
import {
  assessMapping,
  contractFields,
  guidedBindingSupported,
  provisionedContract,
  suggestTypes,
  typeFields
} from "./contract-setup.ts";

const provision = {
  manifest: {
    resources: [
      {
        kind: "schema" as const,
        source: "work.schema.json",
        target: "schemas/work.schema.json"
      },
      {
        kind: "contract" as const,
        source: "work.md",
        target: "_contracts/work.md"
      }
    ]
  },
  resources: [
    {
      source: "work.schema.json",
      document: JSON.stringify({
        title: "Work item",
        type: "object",
        required: ["title"],
        properties: {
          title: { title: "Title", type: "string" },
          done: { title: "Completed", type: "boolean" }
        }
      })
    },
    {
      source: "work.md",
      document: `---
kind: mdbase.contract
contract_type: record
id: example.work
version: 1.0.0
name: Work item
record_schema:
  dialect: json-schema-2020-12
  ref: ../schemas/work.schema.json
---
`
    }
  ],
  provides: [{ id: "example.work", version: "1.0.0" }]
};

test("resolves provisioned contract schemas and suggests semantic field matches", () => {
  const contract = provisionedContract(
    { id: "example.work", version: "1.0.0" },
    [provision]
  );
  assert.ok(contract);
  assert.deepEqual(contractFields(contract).map((field) => field.label), ["Title", "Completed"]);

  const types = [{
    name: "task",
    revision: `sha256:${"1".repeat(64)}`,
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        completed: { type: "boolean" }
      }
    }
  }];
  const suggestions = suggestTypes(contract, types);
  assert.equal(suggestions[0].type.name, "task");
  assert.deepEqual(suggestions[0].fields, { title: "title" });
  assert.equal(suggestions[0].requiredMatched, 1);
});

test("reports incompatible and optional mappings in user-facing terms", () => {
  const contract = provisionedContract(
    { id: "example.work", version: "1.0.0" },
    [provision]
  )!;
  const [title] = contractFields(contract);
  const [count] = typeFields({
    name: "task",
    schema: {
      type: "object",
      properties: { count: { title: "Count", type: "integer" } }
    }
  });
  assert.equal(assessMapping(title, count).level, "error");
  assert.equal(assessMapping(title).level, "error");
});

test("does not treat advanced schemas as universal field matches", () => {
  const contract = {
    id: "example.nullable",
    version: "1.0.0",
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { oneOf: [{ type: "string" }, { type: "null" }] }
      }
    },
    implementations: []
  };
  const type = {
    name: "task",
    schema: {
      type: "object",
      properties: { complete: { type: "boolean" } }
    }
  };
  const contractField = contractFields(contract)[0];
  const booleanField = typeFields(type)[0];
  assert.equal(assessMapping(contractField, booleanField).level, "error");
  assert.deepEqual(suggestTypes(contract, [type]), []);
});

test("keeps advanced binding setup in the editor workflow", () => {
  assert.equal(guidedBindingSupported({
    id: "example.simple",
    version: "1.0.0",
    schema: { type: "object" },
    binding_schema: {
      type: "object",
      properties: { lane: { type: "string" }, enabled: { type: "boolean" } }
    }
  }), true);
  assert.equal(guidedBindingSupported({
    id: "example.advanced",
    version: "1.0.0",
    schema: { type: "object" },
    binding_schema: {
      type: "object",
      properties: { routing: { type: "object" } }
    }
  }), false);
});
