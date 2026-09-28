import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hasMirrorRecordExtension,
  portableMirrorPathKey,
  validatePortableMirrorPath
} from "./portable-path.js";
import { parseRecordDocument } from "./mirror-format.js";

interface PortablePathFixtures {
  accepted: string[];
  rejected: string[];
  aliases: Array<{ left: string; right: string }>;
}

const fixtures = JSON.parse(readFileSync(new URL(
  "../../../test-fixtures/portable-mirror-paths.json",
  import.meta.url
), "utf8")) as PortablePathFixtures;

describe("portable mirror path policy", () => {
  it("accepts the shared portable paths", () => {
    for (const path of fixtures.accepted) {
      expect(() => validatePortableMirrorPath(path), path).not.toThrow();
    }
  });

  it("rejects the shared unsafe paths", () => {
    for (const path of fixtures.rejected) {
      expect(() => validatePortableMirrorPath(path), JSON.stringify(path)).toThrow();
    }
  });

  it("maps shared cross-platform aliases to one physical key", () => {
    for (const { left, right } of fixtures.aliases) {
      expect(portableMirrorPathKey(left), `${left} should alias ${right}`)
        .toBe(portableMirrorPathKey(right));
    }
  });
});

describe("mirror record formats", () => {
  it("materializes only Markdown notes and Obsidian Bases as records", () => {
    expect(hasMirrorRecordExtension("notes/a.md")).toBe(true);
    expect(hasMirrorRecordExtension("views/tasks.base")).toBe(true);
    expect(hasMirrorRecordExtension("tools/run.sh")).toBe(false);
    expect(hasMirrorRecordExtension("config.yaml")).toBe(false);
    expect(hasMirrorRecordExtension("NOTES/A.MD")).toBe(false);
    expect(hasMirrorRecordExtension("NOTES/A.MD", { ignoreCase: true })).toBe(true);
  });

  it("reads a Base's whole file as frontmatter with no body", () => {
    expect(parseRecordDocument("views:\n  - type: table\n    name: Open\n", "views/open.base")).toEqual({
      frontmatter: { views: [{ type: "table", name: "Open" }] },
      body: ""
    });
    expect(parseRecordDocument("---\nviews: []\n---\nBody\n", "notes/a.md")).toEqual({
      frontmatter: { views: [] },
      body: "Body\n"
    });
  });
});
