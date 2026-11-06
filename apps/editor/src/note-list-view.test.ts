import { describe, expect, it } from "vitest";
import { moveListIndex } from "./note-list-view";

describe("moveListIndex", () => {
  it("moves by one, jumps to bounds, and pages", () => {
    expect(moveListIndex(-1, 5, "ArrowDown")).toBe(0);
    expect(moveListIndex(0, 5, "ArrowDown")).toBe(1);
    expect(moveListIndex(4, 5, "ArrowDown")).toBe(4);
    expect(moveListIndex(4, 5, "ArrowUp")).toBe(3);
    expect(moveListIndex(0, 5, "ArrowUp")).toBe(0);
    expect(moveListIndex(2, 5, "Home")).toBe(0);
    expect(moveListIndex(2, 5, "End")).toBe(4);
    expect(moveListIndex(0, 25, "PageDown")).toBe(10);
    expect(moveListIndex(20, 25, "PageDown")).toBe(24);
    expect(moveListIndex(22, 25, "PageUp")).toBe(12);
    expect(moveListIndex(1, 25, "PageUp")).toBe(0);
  });

  it("handles empty and out-of-range inputs", () => {
    expect(moveListIndex(0, 0, "ArrowDown")).toBe(-1);
    expect(moveListIndex(99, 3, "ArrowDown")).toBe(3 - 1);
    expect(moveListIndex(-9, 3, "ArrowUp")).toBe(0);
  });
});
