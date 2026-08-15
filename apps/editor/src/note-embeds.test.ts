import { describe, expect, it } from "vitest";
import { markdownFragment } from "./markdown-fragments";

describe("Markdown transclusion fragments", () => {
  const body = [
    "# Plan",
    "",
    "Opening.",
    "",
    "## Decisions",
    "",
    "Use the shared parser.",
    "",
    "### Detail",
    "",
    "Keep source ranges. ^source-ranges",
    "",
    "## Later",
    "",
    "Ship it."
  ].join("\n");

  it("extracts a heading through its nested subsections", () => {
    expect(markdownFragment(body, "Decisions")).toBe([
      "## Decisions",
      "",
      "Use the shared parser.",
      "",
      "### Detail",
      "",
      "Keep source ranges. ^source-ranges"
    ].join("\n"));
  });

  it("extracts block references without exposing the block marker", () => {
    expect(markdownFragment(body, "^source-ranges")).toBe("Keep source ranges.");
  });

  it("reports missing fragments", () => {
    expect(markdownFragment(body, "Unknown")).toBeUndefined();
  });
});
