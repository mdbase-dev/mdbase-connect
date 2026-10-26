import assert from "node:assert/strict";
import test from "node:test";
import { inspectUiSource } from "./source.mjs";
test("the source guard also parses JavaScript JSX files", () => {
  assert.ok(inspectUiSource("export const UI = () => <p>Hello</p>", "UI.jsx").some((issue) => issue.kind === "unmarked JSX text"));
});
