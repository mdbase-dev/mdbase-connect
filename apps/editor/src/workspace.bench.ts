import { bench, describe } from "vitest";
import { browserListItems } from "./collection-browser";
import { linkMatches, type LinkSuggestion } from "./links";
import type { NoteSummary } from "./model";
import { tags } from "./note";

const now = new Date("2026-11-28T12:00:00Z");
const notes: NoteSummary[] = Array.from({ length: 10_000 }, (_, index) => {
  const path = `Folder ${index % 5}/Note ${index}.md`;
  const frontmatter = { tags: ["common", `area/${index % 100}`] };
  return {
    path, frontmatter, effectiveFrontmatter: frontmatter, types: [],
    file: { path, tags: ["common", `inline/${index % 20}`], mtime: new Date(now.getTime() - index * 3_600_000).toISOString() }
  };
});
const edited = [...notes];
edited[0] = { ...notes[0], effectiveFrontmatter: { tags: ["changed"] } };
const suggestions: LinkSuggestion[] = notes.map(({ path }, index) => ({ path, title: `Note ${index}`, aliases: [`Alias ${index}`] }));
const entries = notes.map(note => ({ kind: "note" as const, path: note.path, note }));

describe("10,000 notes", () => {
  bench("refresh tag counts after editing one note", () => { tags(edited); });
  bench("build rows when returning to All notes", () => { browserListItems(entries, { key: "modified", direction: "desc" }, [], now); });
  bench("rank link picker suggestions for a common prefix", () => { linkMatches(suggestions, "note", undefined, 30, { currentPath: notes[0].path }); });
  bench("rank link picker suggestions for a specific title", () => { linkMatches(suggestions, "note 908", undefined, 30, { currentPath: notes[0].path }); });
});
