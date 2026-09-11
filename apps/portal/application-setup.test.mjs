import assert from "node:assert/strict";
import test from "node:test";
import { configurationSetupSummary, initialContractSetupChoice } from "./src/application-setup.ts";

test("initial setup clones declared defaults without inventing missing values", () => {
  const contract = {
    schema: {},
    binding_schema: { properties: {
      options: { default: { enabled: false } },
      count: { default: 0 },
      absent: { type: "string" },
      malformed: null,
      array: []
    } }
  };
  const choice = initialContractSetupChoice(contract, []);
  assert.deepEqual(choice, {
    mode: "starter", typeName: "", fields: {},
    binding: { options: { enabled: false }, count: 0 }
  });
  choice.binding.options.enabled = true;
  assert.equal(contract.binding_schema.properties.options.default.enabled, false);
  assert.deepEqual(initialContractSetupChoice({ schema: {} }, []).binding, {});
});

test("initial setup retains the existing type suggestion without selecting existing mode", () => {
  const schema = { properties: { title: { type: "string" } }, required: ["title"] };
  const choice = initialContractSetupChoice({ schema }, [{ name: "note", revision: "r1", schema }]);
  assert.equal(choice.mode, "starter");
  assert.equal(choice.typeName, "note");
  assert.deepEqual(choice.fields, { title: "title" });
});

test("renders configuration provisions as exact human-readable extension settings", () => {
  assert.deepEqual(configurationSetupSummary({
    requirement: "tasknotes-base-sources",
    operation: "set_add",
    path: "/x-obsidian/bases/include",
    value: "views/tasknotes/**/*.base"
  }), {
    setting: "x-obsidian → bases → include",
    value: "views/tasknotes/**/*.base"
  });
});

test("decodes JSON pointer segments without interpreting their contents", () => {
  assert.deepEqual(configurationSetupSummary({
    requirement: "fixture",
    operation: "set_add",
    path: "/x-example/a~1b/~0key",
    value: false
  }), {
    setting: "x-example → a/b → ~key",
    value: "false"
  });
});
