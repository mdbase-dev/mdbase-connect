import { describe, expect, it, vi } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  buildNoteSearchIndex,
  IncrementalNoteSearchIndex,
  searchNoteResults,
  searchNotes,
  searchTextRanges
} from "./note-search";
import type { NoteSummary } from "./model";

const notes: NoteSummary[] = [
  summary("Projects/Release planning.md", { title: "Ship the editor", tags: ["roadmap"] }, ["project"], "Prepare the launch."),
  summary("Reading/Interfaces.md", { title: "Calm interfaces" }, ["note"], "Good tools leave room."),
  summary("Journal/Friday.md", { mood: "quiet" }, [], "A small daily note.")
];

const types: CollectionTypeDescriptor[] = [
  displayType("project"),
  displayType("note")
];

function summary(
  path: string,
  frontmatter: NoteSummary["frontmatter"],
  types: string[],
  body: string
): NoteSummary {
  return {
    path,
    frontmatter,
    effectiveFrontmatter: structuredClone(frontmatter),
    types,
    body,
    file: {
      path,
      name: path.split("/").at(-1)!,
      folder: path.split("/").slice(0, -1).join("/"),
      size: body.length,
      mtime: ""
    }
  };
}

describe("note search", () => {
  const index = buildNoteSearchIndex(notes, types);

  it("fuzzy-matches titles and paths while ranking titles first", () => {
    expect(searchNotes(index, "shp edt").map((note) => note.path)).toEqual(["Projects/Release planning.md"]);
    expect(searchNotes(index, "interfaces")[0].path).toBe("Reading/Interfaces.md");
  });

  it("searches tags, types, frontmatter, and body content", () => {
    expect(searchNotes(index, "roadmap")[0].path).toBe("Projects/Release planning.md");
    expect(searchNotes(index, "quiet").map((note) => note.path)).toContain("Journal/Friday.md");
    expect(searchNotes(index, "leave room")[0].path).toBe("Reading/Interfaces.md");
  });

  it("preserves collection order for an empty query", () => {
    expect(searchNotes(index, "")).toEqual(notes);
  });

  it("reuses normalized entries until a note changes", () => {
    const incremental = new IncrementalNoteSearchIndex();
    const first = incremental.build(notes, types);
    const unchanged = incremental.build([...notes], types);
    const changedNote = { ...notes[1], body: "Changed body" };
    const changed = incremental.build([notes[0], changedNote, notes[2]], types);

    expect(unchanged[0]).toBe(first[0]);
    expect(changed[0]).toBe(first[0]);
    expect(changed[1]).not.toBe(first[1]);
  });

  it("returns a highlighted excerpt from the field that matched", () => {
    const [bodyResult] = searchNoteResults(index, "leave room");
    expect(bodyResult.note.path).toBe("Reading/Interfaces.md");
    expect(bodyResult.context).toMatchObject({
      kind: "body",
      text: "Good tools leave room."
    });
    expect(bodyResult.context.ranges.map((range) =>
      bodyResult.context.text.slice(range.from, range.to)
    )).toEqual(["leave", "room"]);

    const [metadataResult] = searchNoteResults(index, "roadmap");
    expect(metadataResult.context.kind).toBe("metadata");
    expect(metadataResult.context.text).toContain("#roadmap");
  });

  it("keeps all 10,000 tied results in input order without constructing contexts", () => {
    const many = Array.from({ length: 10_000 }, (_, i) =>
      summary(`Notes/${String(9999 - i).padStart(4, "0")}.md`, {}, [], "needle body"));
    const entries = buildNoteSearchIndex(many);
    const reads = vi.fn(() => "needle body");
    for (const entry of entries) Object.defineProperty(entry, "bodyText", { get: reads });
    const results = searchNoteResults(entries, "needle");
    expect(results.map((result) => result.note)).toEqual(many);
    expect(reads).not.toHaveBeenCalled();
    expect(searchNotes(entries, "needle")).toEqual(many);
    expect(reads).not.toHaveBeenCalled();
    const context = results[9000].context;
    expect(context.kind).toBe("body");
    expect(results[9000].context).toBe(context);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(searchNoteResults(entries, "needle", 12).map((result) => result.note)).toEqual(many.slice(0, 12));
  });

  it("defers field rescoring and caches whitespace and metadata contexts too", () => {
    const [entry] = buildNoteSearchIndex([summary("Notes/one.md", { tag: "needle" }, [], "")]);
    const metadata = vi.fn(() => "tag: needle");
    const body = vi.fn(() => "");
    Object.defineProperty(entry, "metadataText", { get: metadata });
    Object.defineProperty(entry, "body", { get: body });
    const [result] = searchNoteResults([entry], "needle");
    expect(metadata).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(result.context.kind).toBe("metadata");
    expect(result.context).toBe(result.context);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledTimes(1);
    const path = vi.fn(() => "Notes/one.md");
    Object.defineProperty(entry.note, "path", { get: path });
    const [empty] = searchNoteResults([entry], "   ");
    searchNotes([entry], "   ");
    expect(path).not.toHaveBeenCalled();
    expect(empty.context).toBe(empty.context);
    expect(path).toHaveBeenCalledTimes(1);
  });

  it("still lets body matches outrank expensive fuzzy matches and combines fields per token", () => {
    const slow = summary("a------------------------------b.md", {}, [], "ab");
    const title = summary("ab.md", {}, [], "unrelated");
    const metadata = summary("other.md", { value: "ab" }, [], "");
    const mixed = summary("alpha.md", {}, [], "omega");
    const entries = buildNoteSearchIndex([slow, metadata, title, mixed]);
    expect(searchNotes(entries, "ab")).toEqual([title, metadata, slow]);
    expect(searchNoteResults(entries, "ab").at(-1)?.context.kind).toBe("body");
    expect(searchNotes(entries, "alpha omega")).toEqual([mixed]);
  });

  it("compiles matching expressions once per query, including lazy contexts", () => {
    const entries = buildNoteSearchIndex(Array.from({ length: 100 }, (_, i) =>
      summary(`Notes/${i}.md`, {}, [], "needle body")));
    const OriginalRegExp = globalThis.RegExp;
    const compile = vi.fn(function (pattern: string, flags?: string) {
      return new OriginalRegExp(pattern, flags);
    });
    vi.stubGlobal("RegExp", compile);
    try {
      const results = searchNoteResults(entries, "needle body");
      expect(compile).toHaveBeenCalledTimes(2);
      for (const result of results) expect(result.context.kind).toBe("body");
      expect(compile).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains literal punctuation, accent normalization, and whitespace behavior", () => {
    const special = summary("Notes/special.md", {}, [], "Café [a+b] \\ end");
    const entries = buildNoteSearchIndex([special]);
    expect(searchNotes(entries, "CAFÉ [a+b]")).toEqual([special]);
    expect(searchNoteResults(entries, "CAFÉ [a+b]")[0].context.ranges).toEqual([
      { from: 0, to: 4 }, { from: 5, to: 10 }
    ]);
    expect(searchNotes(index, "  \t\n")).toEqual(notes);
    expect(searchNoteResults(index, "  \t\n")[0].context).toEqual({
      kind: "path", text: notes[0].path, ranges: []
    });
  });

  it("finds every non-overlapping literal search token for quiet highlighting", () => {
    expect(searchTextRanges("Alpha beta alpha", "alpha beta")).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 10 },
      { from: 11, to: 16 }
    ]);
  });

  it("matches and highlights across accents", () => {
    const index = buildNoteSearchIndex([summary("Cafés.md", { title: "Café notes" }, [], "Résumé draft.")]);
    expect(searchNotes(index, "cafe").map((note) => note.path)).toEqual(["Cafés.md"]);
    expect(searchTextRanges("Café notes", "cafe")).toEqual([{ from: 0, to: 4 }]);
    expect(searchTextRanges("Cafe notes", "café")).toEqual([{ from: 0, to: 4 }]);
    expect(searchNoteResults(index, "resume")[0].context).toMatchObject({ kind: "body", text: "Résumé draft.", ranges: [{ from: 0, to: 6 }] });
  });

  it("ranks an alias match just behind a title match and ahead of path and body matches", () => {
    const index = buildNoteSearchIndex([
      summary("Notes/Countess.md", {}, [], "Mentions Ada in passing."),
      summary("People/Lovelace.md", { title: "Augusta King", aliases: ["Ada"] }, [], ""),
      summary("People/Ada.md", { title: "Ada" }, [], "")
    ]);
    expect(searchNotes(index, "ada").map((note) => note.path)).toEqual(["People/Ada.md", "People/Lovelace.md", "Notes/Countess.md"]);
    expect(searchNoteResults(index, "ada")[1].context).toMatchObject({ kind: "metadata", ranges: [expect.anything()] });
  });

  it("reads a body again as a search is typed out only while it still holds the shorter term", () => {
    const long = "quiet words ".repeat(400);
    const index = new IncrementalNoteSearchIndex();
    const entries = index.build([summary("A.md", {}, [], long), summary("B.md", {}, [], `${long} lantern`)]);
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    const bodyReads = (query: string) => {
      indexOf.mockClear();
      const paths = searchNotes(entries, query).map((note) => note.path);
      return { paths, reads: indexOf.mock.contexts.filter((value) => String(value).length >= long.length).length };
    };
    try {
      expect(bodyReads("lant")).toEqual({ paths: ["B.md"], reads: 2 });
      // A.md lacks "lant", so it cannot hold "lantern"; only B.md is read.
      expect(bodyReads("lantern")).toEqual({ paths: ["B.md"], reads: 1 });
      expect(bodyReads("lantern quiet")).toEqual({ paths: ["B.md"], reads: 2 });
      expect(bodyReads("zeb")).toEqual({ paths: [], reads: 2 });
    } finally {
      indexOf.mockRestore();
    }
  });

  it("forgets what a body lacked once its note changes", () => {
    const index = new IncrementalNoteSearchIndex();
    const before = summary("A.md", {}, [], "quiet words");
    expect(searchNotes(index.build([before]), "lant")).toEqual([]);
    const after = { ...before, body: "a lantern" };
    expect(searchNotes(index.build([after]), "lantern")).toEqual([after]);
  });

  it("lets a bonus decide between equally good matches without overriding a better one", () => {
    const index = buildNoteSearchIndex([
      summary("A/Plan.md", {}, [], ""),
      summary("B/Plan.md", {}, [], ""),
      summary("Planning.md", {}, [], "")
    ]);
    const recent = (note: NoteSummary) => note.path === "B/Plan.md" || note.path === "Planning.md" ? 0.3 : 0;
    expect(searchNoteResults(index, "plan", Infinity, recent).map((result) => result.note.path)).toEqual(["B/Plan.md", "A/Plan.md", "Planning.md"]);
  });

  it("takes body matches from indexed answers instead of the text the page holds", () => {
    const listed = buildNoteSearchIndex([
      summary("A.md", {}, [], ""),
      summary("B.md", {}, [], "Mentions the launch in passing."),
      { ...summary("C.md", {}, [], ""), body: undefined }
    ]);
    const answers = new Map([["launch", new Set(["A.md", "C.md"])], ["passing", new Set(["C.md"])]]);
    const texts = new Map([["C.md", "Notes on the launch, passing through."]]);
    const asked: string[] = [];
    const bodies = {
      paths: (term: string) => { asked.push(term); return answers.get(term); },
      text: (note: NoteSummary) => texts.get(note.path)
    };
    // The page's own body for B is not consulted: the collection's answer decides.
    expect(searchNoteResults(listed, "Launch", Infinity, undefined, bodies).map((result) => result.note.path)).toEqual(["A.md", "C.md"]);
    expect(asked).toContain("launch");
    // Every body term must match; a short word is not a body term and must match elsewhere.
    expect(searchNoteResults(listed, "launch passing", Infinity, undefined, bodies).map((result) => result.note.path)).toEqual(["C.md"]);
    expect(searchNoteResults(listed, "launch on", Infinity, undefined, bodies)).toEqual([]);
    // An unanswered term matches nothing yet.
    expect(searchNoteResults(listed, "pending", Infinity, undefined, bodies)).toEqual([]);
    // The excerpt comes from text read for it; without text the excerpt is empty.
    const [a, c] = searchNoteResults(listed, "launch", Infinity, undefined, bodies);
    expect(a.context).toMatchObject({ kind: "body", text: "" });
    expect(c.context.kind).toBe("body");
    expect(c.context.text).toContain("launch");
    expect(c.context.ranges.length).toBeGreaterThan(0);
    // A short word matched elsewhere does not rule out the excerpt of the words asked.
    const [mixed] = searchNoteResults(listed, "launch C", Infinity, undefined, bodies);
    expect(mixed.note.path).toBe("C.md");
    expect(mixed.context.kind).toBe("body");
  });
});

function displayType(name: string): CollectionTypeDescriptor {
  return {
    name,
    definition: {},
    collection: { display: { name_field: "title" } },
    schema: { type: "object", properties: { title: { type: "string" } } },
    extensions: {}
  };
}
