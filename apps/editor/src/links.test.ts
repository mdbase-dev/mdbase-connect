import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { NoteSummary } from "./model";
import {
  backlinksFor,
  linkMatches,
  linkSuggestions,
  resolveLinkSuggestion,
  resolveLinkSuggestionMatches,
  unresolvedNoteTarget,
  wikilinkFor
} from "./links";

describe("collection links", () => {
  const types = [displayType("note"), displayType("person")];
  const notes = [
    note("Notes/alpha.md", "Alpha", ["Projects/project.md"]),
    note("Projects/project.md", "Launch project"),
    note("Projects/brief.md", "Brief", ["project"]),
    note("Archive/project.md", "Old project"),
    note("Notes/embed.md", "Embed", [], ["Projects/project"])
  ];

  it("builds backlinks from links, simple names, and embeds", () => {
    expect(backlinksFor("Projects/project.md", notes, types).map((candidate) => candidate.path)).toEqual([
      "Notes/alpha.md",
      "Projects/brief.md",
      "Notes/embed.md"
    ]);
  });

  it("prefers a simple-name target in the referring note's folder", () => {
    expect(backlinksFor("Archive/project.md", notes, types)).toEqual([]);
  });

  it("creates readable, path-stable wikilinks", () => {
    const suggestions = linkSuggestions(notes, [], types);
    expect(wikilinkFor(suggestions.find((item) => item.path === "Projects/project.md")!)).toBe("Projects/project|Launch project");
    expect(wikilinkFor({ path: "Notes/alpha.md", title: "alpha" })).toBe("Notes/alpha");
  });

  it("builds mdbase-aware suggestions and finds aliases within a type", () => {
    const people = [
      {
        ...note("People/ada.md", "Ada Lovelace"),
        frontmatter: { title: "Ada Lovelace", aliases: ["Ada", "Countess of Lovelace"] },
        effectiveFrontmatter: { title: "Ada Lovelace", aliases: ["Ada", "Countess of Lovelace"] },
        types: ["person", "legacy"]
      },
      { ...note("Notes/ada.md", "Ada notes"), types: ["note"] }
    ];
    const suggestions = linkSuggestions(people, ["person", "note"], types);

    expect(suggestions[0].types).toEqual(["person"]);
    expect(suggestions[0].aliases).toEqual(["Ada", "Countess of Lovelace"]);
    expect(linkMatches(suggestions, "countess", "person")).toMatchObject([{
      label: "Countess of Lovelace",
      suggestion: { path: "People/ada.md" }
    }]);
    expect(linkMatches(suggestions, "ada", "person")).toHaveLength(1);
    expect(wikilinkFor(suggestions[0], "Countess of Lovelace")).toBe("People/ada|Countess of Lovelace");
  });

  it("ranks nearby and recently opened notes ahead of otherwise equal matches", () => {
    const suggestions = linkSuggestions([
      note("Notes/project.md", "Project"),
      note("Archive/project.md", "Project")
    ], [], types);

    expect(linkMatches(suggestions, "project", undefined, undefined, {
      currentPath: "Notes/source.md"
    })[0].suggestion.path).toBe("Notes/project.md");

    expect(linkMatches(suggestions, "project", undefined, undefined, {
      currentPath: "Notes/source.md",
      recentPaths: ["Archive/project.md"]
    })[0].suggestion.path).toBe("Archive/project.md");
  });

  it("finds subsequence matches without making short queries noisy", () => {
    const suggestions = linkSuggestions([
      note("People/ada-lovelace.md", "Ada Lovelace"),
      note("Notes/a-different-list.md", "A different list")
    ], [], types);

    expect(linkMatches(suggestions, "adlv")).toMatchObject([{
      suggestion: { path: "People/ada-lovelace.md" }
    }]);
  });

  it("exposes ambiguous simple names and rejects collection traversal", () => {
    const suggestions = linkSuggestions([
      note("Notes/project.md", "Project"),
      note("Archive/project.md", "Project")
    ], [], types);

    expect(resolveLinkSuggestionMatches("project", suggestions, "Notes/source.md").map((item) => item.path)).toEqual([
      "Notes/project.md",
      "Archive/project.md"
    ]);
    expect(resolveLinkSuggestion("../../Archive/project", suggestions, "Notes/source.md", "markdown")).toBeUndefined();
  });

  it("turns unresolved Markdown and wiki targets into nearby notes", () => {
    expect(unresolvedNoteTarget(
      "fresh-idea.md",
      "Fresh idea",
      "Notes/source.md",
      "markdown"
    )).toEqual({ path: "Notes/fresh-idea.md", title: "Fresh idea" });
    expect(unresolvedNoteTarget(
      "Projects/launch",
      undefined,
      "Notes/source.md",
      "wikilink"
    )).toEqual({ path: "Projects/launch.md", title: "launch" });
    expect(unresolvedNoteTarget(
      "../shared",
      undefined,
      "Notes/Drafts/source.md",
      "markdown"
    )).toEqual({ path: "Notes/shared.md", title: "shared" });
  });

  it("does not turn external, escaping, or non-Markdown targets into notes", () => {
    expect(unresolvedNoteTarget("https://example.com", "Example", "Notes/source.md", "markdown")).toBeUndefined();
    expect(unresolvedNoteTarget("../../outside", undefined, "Notes/source.md", "markdown")).toBeUndefined();
    expect(unresolvedNoteTarget("diagram.png", undefined, "Notes/source.md", "markdown")).toBeUndefined();
  });
});

function note(path: string, title: string, links: unknown[] = [], embeds: unknown[] = []): NoteSummary {
  return {
    path,
    frontmatter: { title },
    effectiveFrontmatter: { title },
    types: ["note"],
    file: { path, name: path.split("/").at(-1)!, folder: path.split("/").slice(0, -1).join("/"), size: 1, mtime: "", links, embeds }
  };
}

function displayType(name: string): CollectionTypeDescriptor {
  return {
    name,
    definition: {},
    collection: { display: { name_field: "title" } },
    schema: { type: "object", properties: { title: { type: "string" } } },
    extensions: {}
  };
}
