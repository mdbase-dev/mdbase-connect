import assert from "node:assert/strict";
import test from "node:test";
import { configurationSetupSummary } from "./src/application-setup.ts";

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
