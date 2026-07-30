import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  portableMirrorPathKey,
  validatePortableMirrorPath
} from "./portable-path.js";

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
