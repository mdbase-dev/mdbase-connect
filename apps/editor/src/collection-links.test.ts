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

  it("resolves a unique file embed basename and reports ambiguity when multiple files share it", async () => {
    const resolveLinks = vi.fn(async (_from: string, raws: readonly string[]) =>
      raws.map((): LinkTarget => ({ kind: "missing" })));
    const file = (path: string) => ({
      fileId: path, path, revision: "r1", contentDigest: "sha256:0" as const, size: 10,
      mediaClass: "other" as const, modifiedAt: "2026-08-07T00:00:00Z"
    });
    const targets = new LinkTargets({ resolveLinks }, "Notes/today.md", undefined, [
      file("Attachments/page.html"),
      file("Attachments/dup.html"),
      file("Archive/dup.html")
    ]);
    await targets.resolveAll(["![[page.html]]", "![[PAGE.HTML|Preview]]", "![[dup.html]]", "![[missing.html]]"]);
    expect(targets.get("![[page.html]]")).toEqual({ kind: "file", path: "Attachments/page.html" });
    expect(targets.get("![[PAGE.HTML|Preview]]")).toEqual({ kind: "file", path: "Attachments/page.html" });
    expect(targets.get("![[dup.html]]")).toEqual({
      kind: "ambiguous",
      candidates: ["Archive/dup.html", "Attachments/dup.html"]
    });
    expect(targets.get("![[missing.html]]")).toEqual({ kind: "missing" });
  });
});
