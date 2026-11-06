import { beforeEach, describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import { browserListItems, collectionBrowserEntries } from "./collection-browser";
import type { CollectionFile, NoteSummary } from "./model";
import {
  defaultNoteSort,
  loadNoteSort,
  noteSortDirections,
  noteSortSummary,
  resolveNoteSort,
  saveNoteSort,
  sortableFields,
  type NoteSort,
  type SortField
} from "./note-sort";

const taskSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    due: { type: "string", format: "date" },
    reviewed: { type: "string", format: "date-time" },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    effort: { type: "integer" },
    owner: { type: ["string", "null"] },
    done: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    untouched: { type: "number" }
  }
} satisfies JsonObject;
const task = descriptor("task", taskSchema);

describe("note order", () => {
  const types = [descriptor("note", { type: "object", properties: { title: { type: "string" } } })];
  const notes = [
    note("Archive/Zebra.md", { title: "Zebra" }, "2026-01-03T00:00:00.000Z"),
    note("Notes/alpha-10.md", { title: "Alpha 10" }, "2026-01-01T00:00:00.000Z"),
    note("Notes/alpha-2.md", { title: "Alpha 2" }, "2026-01-02T00:00:00.000Z"),
    note("Inbox/Undated.md", { title: "Undated" }, "")
  ];
  const order = (sort: NoteSort, input = notes, files: CollectionFile[] = []) =>
    collectionBrowserEntries(input, files, sort, types).map((entry) => entry.path);

  it("sorts by modified time, title, and path without moving undated notes above dated notes", () => {
    expect(order(defaultNoteSort)).toEqual(["Archive/Zebra.md", "Notes/alpha-2.md", "Notes/alpha-10.md", "Inbox/Undated.md"]);
    expect(order({ key: "modified", direction: "asc" })).toEqual(["Notes/alpha-10.md", "Notes/alpha-2.md", "Archive/Zebra.md", "Inbox/Undated.md"]);
    expect(order({ key: "title", direction: "asc" })).toEqual(["Notes/alpha-2.md", "Notes/alpha-10.md", "Inbox/Undated.md", "Archive/Zebra.md"]);
    expect(order({ key: "title", direction: "desc" })).toEqual(["Archive/Zebra.md", "Inbox/Undated.md", "Notes/alpha-10.md", "Notes/alpha-2.md"]);
    expect(order({ key: "path", direction: "asc" })).toEqual(["Archive/Zebra.md", "Inbox/Undated.md", "Notes/alpha-2.md", "Notes/alpha-10.md"]);
  });

  it("orders field values by kind and keeps notes and files without one last in either direction", () => {
    const tasks = [
      note("low.md", { priority: "low", effort: 10, due: "2026-03-01" }),
      note("high.md", { priority: "high", effort: 2, due: "2026-01-15" }),
      note("medium.md", { priority: "medium", effort: 9.5, due: "2026-02-01" }),
      note("blank.md", { priority: "not listed", effort: "many", due: "someday" })
    ];
    const fields = sortableFields(tasks, [task]);
    const field = (name: string) => fields.find((candidate) => candidate.name === name)!;
    const files = [{ path: "a.png" } as CollectionFile];
    const sorted = (name: string, direction: "asc" | "desc") => order({ key: "field", field: field(name), direction }, tasks, files);

    expect(sorted("priority", "asc")).toEqual(["low.md", "medium.md", "high.md", "a.png", "blank.md"]);
    expect(sorted("priority", "desc")).toEqual(["high.md", "medium.md", "low.md", "a.png", "blank.md"]);
    expect(sorted("effort", "asc")).toEqual(["high.md", "medium.md", "low.md", "a.png", "blank.md"]);
    expect(sorted("due", "desc")).toEqual(["low.md", "medium.md", "high.md", "a.png", "blank.md"]);
  });

  it("groups field values by what they mean", () => {
    const tasks = [
      note("a.md", { due: "2026-01-01", priority: "high", effort: 1, owner: "Sam" }),
      note("b.md", { due: "2026-02-01", priority: "low", effort: 2, owner: "alex" }),
      note("c.md", {})
    ];
    const fields = sortableFields(tasks, [task]);
    const headers = (name: string) => {
      const sort: NoteSort = { key: "field", field: fields.find((field) => field.name === name)!, direction: "asc" };
      return browserListItems(collectionBrowserEntries(tasks, [], sort, [task]), sort, [task])
        .flatMap((item) => item.kind === "header" ? [item.label] : []);
    };

    expect(headers("due")).toEqual(["January 2026", "February 2026", "No value"]);
    expect(headers("priority")).toEqual(["low", "high", "No value"]);
    expect(headers("effort")).toEqual(["Effort", "No value"]);
    expect(headers("owner")).toEqual(["A", "S", "No value"]);
  });
});

describe("sortable fields", () => {
  it("offers scalar fields with a value in scope, leaving out the name field", () => {
    const fields = sortableFields([
      note("a.md", { title: "A", due: "2026-01-01", reviewed: "2026-01-01T10:00:00Z", priority: "low", effort: 3, owner: "Sam", done: true, labels: ["x"] })
    ], [task]);
    expect(fields.map((field) => [field.name, field.kind])).toEqual([
      ["due", "date"],
      ["reviewed", "date-time"],
      ["priority", "choice"],
      ["effort", "number"],
      ["owner", "text"]
    ]);
  });

  it("follows the scope and matches types case-insensitively", () => {
    const person = descriptor("Person", { type: "object", properties: { birthday: { type: "string", format: "date" } } });
    const tasks = note("a.md", { due: "2026-01-01" });
    const people = note("b.md", { birthday: "1990-01-01" }, "", ["person"]);
    expect(sortableFields([tasks], [task, person]).map((field) => field.name)).toEqual(["due"]);
    expect(sortableFields([people], [task, person]).map((field) => field.name)).toEqual(["birthday"]);
    expect(sortableFields([tasks, people], [task, person]).map((field) => field.name)).toEqual(["birthday", "due"]);
  });

  it("leaves out a name two types declare differently and keeps one they share", () => {
    const left = descriptor("left", { type: "object", properties: { status: { type: "string", enum: ["a"] }, rank: { type: "number" } } });
    const right = descriptor("right", { type: "object", properties: { status: { type: "string", enum: ["b"] }, rank: { type: "number" } } });
    const notes = [note("a.md", { status: "a", rank: 1 }, "", ["left"]), note("b.md", { status: "b", rank: 2 }, "", ["right"])];
    expect(sortableFields(notes, [left, right]).map((field) => field.name)).toEqual(["rank"]);
  });

  it("resolves local references", () => {
    const type = descriptor("ref", { type: "object", $defs: { day: { type: "string", format: "date" } }, properties: { due: { $ref: "#/$defs/day" } } });
    expect(sortableFields([note("a.md", { due: "2026-01-01" }, "", ["ref"])], [type])).toEqual([{ name: "due", label: "Due", kind: "date" }]);
  });

  it("offers nothing for untyped notes", () => {
    expect(sortableFields([note("a.md", { due: "2026-01-01" }, "", [])], [task])).toEqual([]);
  });
});

describe("sort preference", () => {
  const due: SortField = { name: "due", label: "Due", kind: "date" };
  beforeEach(() => localStorage.clear());

  it("keeps a field choice while the field is out of scope", () => {
    const preference = { key: "field:due", direction: "desc" } as const;
    expect(resolveNoteSort(preference, [due])).toEqual({ key: "field", field: due, direction: "desc" });
    expect(resolveNoteSort(preference, [])).toEqual(defaultNoteSort);
    expect(resolveNoteSort({ key: "title", direction: "desc" }, [])).toEqual({ key: "title", direction: "desc" });
  });

  it("persists per collection and repairs unreadable values", () => {
    expect(loadNoteSort("one")).toEqual({ key: "modified", direction: "desc" });
    saveNoteSort("one", { key: "field:due", direction: "asc" });
    expect(loadNoteSort("one")).toEqual({ key: "field:due", direction: "asc" });
    expect(loadNoteSort("two")).toEqual({ key: "modified", direction: "desc" });

    localStorage.setItem("mdbase-editor:note-sort:one", "random");
    expect(loadNoteSort("one")).toEqual({ key: "modified", direction: "desc" });
    localStorage.setItem("mdbase-editor:note-sort:one", JSON.stringify({ key: "title", direction: "sideways" }));
    expect(loadNoteSort("one")).toEqual({ key: "modified", direction: "desc" });
  });

  it("describes the order in the words of the field", () => {
    expect(noteSortSummary(defaultNoteSort)).toBe("");
    expect(noteSortSummary({ key: "modified", direction: "asc" })).toBe("Modified: Oldest first");
    expect(noteSortSummary({ key: "field", field: due, direction: "asc" })).toBe("Due: Earliest first");
    expect(noteSortDirections({ key: "field", field: { name: "n", label: "N", kind: "number" }, direction: "asc" }).map((option) => option.label)).toEqual(["Low to high", "High to low"]);
  });
});

function note(path: string, values: JsonObject, mtime = "", types = ["task"]): NoteSummary {
  return {
    path,
    frontmatter: {},
    effectiveFrontmatter: values,
    types,
    file: { path, name: path, folder: "", size: 0, mtime }
  } as NoteSummary;
}

function descriptor(name: string, schema: JsonObject): CollectionTypeDescriptor {
  return { name, definition: {}, collection: { display: { name_field: "title" } }, schema, extensions: {} };
}
