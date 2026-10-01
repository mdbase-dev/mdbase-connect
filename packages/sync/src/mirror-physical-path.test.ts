import { describe, expect, it } from "vitest";
import { assertNoPhysicalPathAliases } from "./mirror-physical-path.js";

describe("physical path ownership policy", () => {
  it.each([
    ["Notes/Entry.md", "notes/entry.md"],
    ["notes/caf\u00e9.md", "notes/cafe\u0301.md"]
  ])("distinguishes local aliases from stable replica spellings: %s / %s", (left, right) => {
    expect(() => assertNoPhysicalPathAliases([left, right])).toThrowError(
      expect.objectContaining({ code: "invalid_record_path" })
    );
    expect(() => assertNoPhysicalPathAliases([
      { path: left, entity: "record", identity: "one" },
      { path: right, entity: "record", identity: "one" }
    ])).not.toThrow();
    for (const owner of [
      { entity: "record", identity: "two" },
      { entity: "file", identity: "one" }
    ]) {
      expect(() => assertNoPhysicalPathAliases([
        { path: left, entity: "record", identity: "one" },
        { path: right, ...owner }
      ])).toThrowError(expect.objectContaining({ code: "invalid_record_path" }));
    }
  });
});
