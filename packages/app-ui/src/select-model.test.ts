import { describe, expect, it } from "vitest";

import {
  edgeOption,
  extendTypeahead,
  flattenOptions,
  itemOffsets,
  stepOption,
  typeaheadOption,
} from "./select-model.js";

const options = [
  { value: "inbox", label: "Inbox" },
  { value: "queued", label: "Queued", disabled: true },
  { value: "reading", label: "Reading" },
  { value: "read-later", label: "Read later" },
  { value: "archived", label: "Archived" },
];

describe("select model", () => {
  it("flattens groups in order and records where each item starts", () => {
    const items = [
      { value: "current", label: "Current" },
      {
        label: "Common",
        options: [
          { value: "book", label: "Book" },
          { value: "article", label: "Article" },
        ],
      },
      { value: "other", label: "Other" },
    ];
    expect(flattenOptions(items).map(({ value, group }) => [value, group])).toEqual([
      ["current", undefined],
      ["book", "Common"],
      ["article", "Common"],
      ["other", undefined],
    ]);
    expect(itemOffsets(items)).toEqual([0, 1, 3]);
  });

  it("steps over disabled options and stops at the ends", () => {
    expect(stepOption(options, 0, 1)).toBe(2);
    expect(stepOption(options, 2, -1)).toBe(0);
    expect(stepOption(options, 4, 1)).toBe(4);
    expect(edgeOption(options, "first")).toBe(0);
    expect(edgeOption(options, "last")).toBe(4);
    expect(edgeOption([{ value: "x", label: "X", disabled: true }], "first")).toBe(-1);
  });

  it("matches typed prefixes and cycles on a repeated letter", () => {
    expect(typeaheadOption(options, "rea", 0)).toBe(2);
    expect(typeaheadOption(options, "read ", 0)).toBe(3);
    expect(typeaheadOption(options, "r", 2)).toBe(3);
    expect(typeaheadOption(options, "rr", 3)).toBe(2);
    expect(typeaheadOption(options, "q", 0)).toBe(-1);
  });

  it("starts a new search after a pause", () => {
    const typed = extendTypeahead({ text: "", at: 0 }, "r", 1000);
    expect(extendTypeahead(typed, "e", 1200).text).toBe("re");
    expect(extendTypeahead(typed, "a", 2000).text).toBe("a");
  });
});
