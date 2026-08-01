import { describe, expect, it } from "vitest";
import { compareLines } from "./text-diff";

describe("compareLines", () => {
  it("labels local and remote changes with their source line numbers", () => {
    expect(compareLines("one\nlocal\nthree", "one\nremote\nthree")).toEqual([
      { kind: "same", text: "one", localLine: 1, remoteLine: 1 },
      { kind: "local", text: "local", localLine: 2 },
      { kind: "remote", text: "remote", remoteLine: 2 },
      { kind: "same", text: "three", localLine: 3, remoteLine: 3 }
    ]);
  });

  it("returns no rows for identical content", () => {
    expect(compareLines("same\ntext", "same\ntext")).toEqual([]);
  });

  it("bounds very large comparisons and retains the changed content", () => {
    const local = Array.from({ length: 300 }, (_, index) => index === 150 ? "local" : `line ${index}`).join("\n");
    const remote = Array.from({ length: 300 }, (_, index) => index === 150 ? "remote" : `line ${index}`).join("\n");
    const result = compareLines(local, remote);
    expect(result.some((line) => line.kind === "local" && line.text === "local")).toBe(true);
    expect(result.some((line) => line.kind === "remote" && line.text === "remote")).toBe(true);
    expect(result.length).toBeLessThan(20);
  });
});
