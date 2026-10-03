import { describe, expect, it } from "vitest";
import { MdbaseConnectError, type CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { connectProblem } from "@mdbase-dev/connect/advanced";
import { bulkFields, runNoteBatch } from "./bulk-note-actions";

const types: CollectionTypeDescriptor[] = [
  { name: "one", definition: {}, extensions: {}, schema: { properties: { status: { type: "string" }, onlyOne: { type: "number" } } } },
  { name: "two", definition: {}, extensions: {}, schema: { properties: { status: { type: "string" }, onlyTwo: { type: "boolean" } } } }
];

describe("bulk property contracts", () => {
  it("enables shared declarations across different types and disables unshared ones", () => {
    expect(bulkFields([{ types: ["one"] }, { types: ["two"] }], types).map(({ name, shared }) => ({ name, shared })))
      .toEqual([{ name: "onlyOne", shared: false }, { name: "onlyTwo", shared: false }, { name: "status", shared: true }]);
    expect(bulkFields([{ types: ["one"] }, { types: [] }], types).every((field) => !field.shared)).toBe(true);
    expect(bulkFields([{ types: ["one"] }, { types: ["one"] }], types).every((field) => field.shared)).toBe(true);
  });
  it("doesn't treat incompatible schemas as a shared editable field", () => {
    const incompatible = { ...types[1], schema: { properties: { status: { type: "number" } } } };
    expect(bulkFields([{ types: ["one"] }, { types: ["two"] }], [types[0], incompatible]).find((field) => field.name === "status")?.shared).toBe(false);
  });
});

it("stops on an uncertain outcome and reports unattempted notes instead of issuing more writes", async () => {
  const seen: string[] = [];
  const result = await runNoteBatch(["a", "b", "c"], async (path) => {
    seen.push(path);
    throw new MdbaseConnectError(connectProblem("operation_outcome_unknown", "Needs recovery", { details: { request_id: "test-request" } }));
  });
  expect(seen).toEqual(["a"]);
  expect(result.failed.map(({ path }) => path)).toEqual(["a", "b", "c"]);
});

it("runs each note once, reports partial failures, and continues the remainder", async () => {
  const seen: string[] = [];
  const result = await runNoteBatch(["a", "b", "b", "c", "d"], async (path) => {
    seen.push(path);
    if (path === "b") throw new Error("conflict");
    if (path === "d") return;
    return `undo:${path}`;
  });
  expect(seen).toEqual(["a", "b", "c", "d"]);
  expect(result.succeeded).toEqual([{ path: "a", value: "undo:a" }, { path: "c", value: "undo:c" }]);
  expect(result.failed.map(({ path }) => path)).toEqual(["b"]);
});
