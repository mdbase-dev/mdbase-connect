import { describe, expect, it } from "vitest";
import type { NoteSummary } from "./model";
import { backlinksFor, linkMatches, linkSuggestions, wikilinkFor } from "./links";

describe("collection links", () => {
  const notes = [
    note("Notes/alpha.md", "Alpha", ["Projects/project.md"]),
    note("Projects/project.md", "Launch project"),
    note("Projects/brief.md", "Brief", ["project"]),
    note("Archive/project.md", "Old project"),
    note("Notes/embed.md", "Embed", [], ["Projects/project"])
  ];

  it("builds backlinks from links, simple names, and embeds", () => {
    expect(backlinksFor("Projects/project.md", notes).map((candidate) => candidate.path)).toEqual([
      "Notes/alpha.md",
      "Projects/brief.md",
      "Notes/embed.md"
    ]);
  });

  it("prefers a simple-name target in the referring note's folder", () => {
    expect(backlinksFor("Archive/project.md", notes)).toEqual([]);
  });

  it("creates readable, path-stable wikilinks", () => {
    const suggestions = linkSuggestions(notes);
    expect(wikilinkFor(suggestions.find((item) => item.path === "Projects/project.md")!)).toBe("Projects/project|Launch project");
    expect(wikilinkFor({ path: "Notes/alpha.md", title: "alpha" })).toBe("Notes/alpha");
  });

  it("builds mdbase-aware suggestions and finds aliases within a type", () => {
    const people = [
      {
        ...note("People/ada.md", "Ada Lovelace"),
        frontmatter: { title: "Ada Lovelace", aliases: ["Ada", "Countess of Lovelace"] },
        types: ["person", "legacy"]
      },
      { ...note("Notes/ada.md", "Ada notes"), types: ["note"] }
    ];
    const suggestions = linkSuggestions(people, ["person", "note"]);

    expect(suggestions[0].types).toEqual(["person"]);
    expect(suggestions[0].aliases).toEqual(["Ada", "Countess of Lovelace"]);
    expect(linkMatches(suggestions, "countess", "person")).toMatchObject([{
      label: "Countess of Lovelace",
      suggestion: { path: "People/ada.md" }
    }]);
    expect(linkMatches(suggestions, "ada", "person")).toHaveLength(1);
    expect(wikilinkFor(suggestions[0], "Countess of Lovelace")).toBe("People/ada|Countess of Lovelace");
  });
});

function note(path: string, title: string, links: unknown[] = [], embeds: unknown[] = []): NoteSummary {
  return {
    path,
    frontmatter: { title },
    types: [],
    file: { name: path.split("/").at(-1)!, folder: path.split("/").slice(0, -1).join("/"), size: 1, mtime: "", links, embeds }
  };
}
