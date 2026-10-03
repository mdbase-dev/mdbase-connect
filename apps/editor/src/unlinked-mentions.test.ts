import { describe, expect, it } from "vitest";
import { buildNoteSearchIndex } from "./note-search";
import { linkMention, unlinkedMentions } from "./unlinked-mentions";
import type { NoteSummary } from "./model";
const note = (path: string, body?: string): NoteSummary => ({ path, body, types: [], frontmatter: {}, effectiveFrontmatter: {}, file: { path, name: path, folder: "", size: body?.length ?? 0, mtime: "" } });

describe("unlinked mentions", () => {
  it("reuses hydrated search bodies, matches case-insensitive word boundaries, and excludes self and links", () => {
    const index = buildNoteSearchIndex([
      note("Atlas.md", "Atlas"), note("other.md", "atlas and ATLAS"),
      note("words.md", "Atlases preAtlas Atlas_Atlas"), note("linked.md", "[[Atlas]] [Atlas](Atlas.md) ![[Atlas]]"),
      note("empty.md"), note("code.md", "`Atlas`\n\n```md\nAtlas\n```"),
      note("mixed.md", "[[Atlas]] then atlas.")
    ]);
    const matches = unlinkedMentions(index, "Atlas.md", "Atlas");
    expect(matches.map((mention) => mention.note.path)).toEqual(["other.md", "mixed.md"]);
    expect(matches[0]).toMatchObject({ from: 0, to: 5, snippet: "atlas and ATLAS" });
    expect(matches[1].body.slice(matches[1].from, matches[1].to)).toBe("atlas");
  });
  it("escapes title punctuation, handles Unicode boundaries, and supplies a bounded snippet", () => {
    const index = buildNoteSearchIndex([note("other.md", `${"x ".repeat(100)}Été (2026) — été (2026)! ${"y ".repeat(100)}`), note("word.md", "préÉté (2026)")]);
    const mentions = unlinkedMentions(index, "target.md", "Été (2026)");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].snippet.length).toBeLessThan(120);
    expect(mentions[0].snippet).toContain("Été (2026)");
    expect(unlinkedMentions(index, "target.md", "")).toEqual([]);
  });
  it("excludes H1 titles and longer source-title phrases, but keeps independent prose mentions", () => {
    const index = buildNoteSearchIndex([
      note("heading.md", "# Atlas\n\nNo prose mention."),
      note("setext.md", "Atlas\n=====\n\nNo prose mention."),
      note("prefix.md", "# The shape of useful tools 8\n\nThe shape of useful tools **8** is this note’s name."),
      note("Atlas expansion.md", "Atlas expansion is this file’s name."),
      note("real.md", "# Atlas expansion\n\nAtlas expansion is the title. An atlas helps me explore.")
    ]);
    expect(unlinkedMentions(index, "target.md", "The shape of useful tools")).toEqual([]);
    const mentions = unlinkedMentions(index, "target.md", "Atlas");
    expect(mentions.map((mention) => mention.note.path)).toEqual(["real.md"]);
    expect(mentions[0].body.slice(mentions[0].from, mentions[0].to)).toBe("atlas");
  });
  it("strips Markdown from the complete paragraph and emphasises the selected phrase without changing source offsets", () => {
    const body = "# Source title\n\n> I keep **Atlas** beside [my notes](https://example.org) and `code`.";
    const [mention] = unlinkedMentions(buildNoteSearchIndex([note("source.md", body)]), "Atlas.md", "Atlas");
    expect(mention.snippet).toBe("I keep Atlas beside my notes and code.");
    expect(mention.snippetRanges.map((range) => mention.snippet.slice(range.from, range.to))).toEqual(["Atlas"]);
    expect(mention.from).toBe(body.indexOf("Atlas"));
    expect(linkMention(mention, "Atlas.md", body).body).toContain("**[[Atlas|Atlas]]**");
  });
  it.each(["*Atlas*", "I keep *a word,Atlas* here.", "[[Atlas]] then **Atlas**."])("emphasises the actual unlinked occurrence in %s", (body) => {
    const [mention] = unlinkedMentions(buildNoteSearchIndex([note("source.md", body)]), "Atlas.md", "Atlas");
    const [range] = mention.snippetRanges;
    expect(mention.snippet.slice(range.from, range.to)).toBe("Atlas");
    expect(range.from).toBe(mention.snippet.lastIndexOf("Atlas"));
    expect(mention.snippet).not.toContain("*");
    expect(mention.snippet).not.toContain("\uE000");
    expect(mention.body.slice(mention.from, mention.to)).toBe("Atlas");
  });
  it("preserves Unicode emphasis offsets and source-title word boundaries", () => {
    const [mention] = unlinkedMentions(buildNoteSearchIndex([note("source.md", "İ keeps **Atlas**.")]), "Atlas.md", "Atlas");
    expect(mention.snippet.slice(mention.snippetRanges[0].from, mention.snippetRanges[0].to)).toBe("Atlas");
    const title = "The shape of useful tools";
    const [differentPhrase] = unlinkedMentions(buildNoteSearchIndex([note("source.md", `# ${title} 8\n\n${title} 80 is a different phrase.`)]), "target.md", title);
    expect(differentPhrase.snippet).toContain("80 is a different phrase.");
  });
  it("does not leak a clipped link destination or the source H1 into a long snippet", () => {
    const body = `# Source title\n\n[An earlier reference](https://example.org/${"long/".repeat(30)}) ${"before ".repeat(20)}**Atlas** ${"after ".repeat(20)}`;
    const [mention] = unlinkedMentions(buildNoteSearchIndex([note("source.md", body)]), "Atlas.md", "Atlas");
    expect(mention.snippet).toContain("Atlas");
    expect(mention.snippet).not.toMatch(/Source title|https:|\*|\[|\]/);
    expect(mention.snippet.length).toBeLessThan(120);
  });

  it("converts only the selected occurrence, preserves spelling, and refuses stale bodies", () => {
    const [mention] = unlinkedMentions(buildNoteSearchIndex([note("other.md", "An atlas, then Atlas.")]), "Notes/Atlas.md", "Atlas");
    expect(linkMention(mention, "Notes/Atlas.md", mention.body)).toEqual({ body: "An [[Notes/Atlas|atlas]], then Atlas.", inserted: "[[Notes/Atlas|atlas]]" });
    expect(() => linkMention(mention, "Notes/Atlas.md", "A changed Atlas.")).toThrow("That note changed");
  });
});
