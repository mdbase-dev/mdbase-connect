import { describe, expect, it, vi } from "vitest";
import { LinkTargets } from "./collection-links";
import type { LinkTarget } from "./model";

describe("LinkTargets", () => {
  it("reads older Editor attachment links from the collection root, for files only", async () => {
    const answers: Record<string, LinkTarget> = {
      "![a.png](</Notes/Attachments/a.png>)": { kind: "file", path: "Notes/Attachments/a.png" },
      "[b](</Notes/b>)": { kind: "note", path: "Notes/b.md" }
    };
    const resolveLinks = vi.fn(async (_from: string, raws: readonly string[]) =>
      raws.map((raw): LinkTarget => answers[raw] ?? { kind: "missing" }));
    const targets = new LinkTargets({ resolveLinks }, "Notes/today.md");
    const written = ["![a.png](<Notes/Attachments/a.png>)", "[b](<Notes/b>)", "[[Notes/c]]", "![d](./d.png)"];
    await targets.resolveAll(written);
    expect(written.map((raw) => targets.get(raw))).toEqual([
      { kind: "file", path: "Notes/Attachments/a.png" },
      { kind: "missing" },
      { kind: "missing" },
      { kind: "missing" }
    ]);
    expect(resolveLinks.mock.calls.map(([, raws]) => raws)).toEqual([
      written,
      ["![a.png](</Notes/Attachments/a.png>)", "[b](</Notes/b>)"]
    ]);
  });
});
