import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  beginNewNote,
  changedNewNote,
  newNoteBlocker,
  newNoteContext,
  newNoteForm,
  newNoteInput,
  newNotePath,
  newNoteStarted,
  occupiedPaths,
  titledPath
} from "./new-note";

const meeting: CollectionTypeDescriptor = {
  name: "meeting",
  extensions: {},
  definition: { match: { path_glob: "Meetings/**/*.md" } },
  schema: {
    type: "object",
    required: ["type", "date", "status"],
    properties: {
      type: { const: "meeting" },
      date: { type: "string", format: "date" },
      status: { type: "string", enum: ["planned", "held"], default: "planned" },
      attendees: { type: "array", items: { type: "string" } }
    }
  }
};
const contact: CollectionTypeDescriptor = {
  name: "contact",
  extensions: {},
  collection: { display: { name_field: "name" } },
  schema: {
    type: "object",
    required: ["type", "name"],
    properties: { type: { const: "contact" }, name: { type: "string", minLength: 1 }, tags: { type: "array", items: { type: "string" } } }
  }
};
const types = [meeting, contact];

describe("where a new note starts", () => {
  it("takes the list's tag, type or folder", () => {
    expect(newNoteContext(undefined, types)).toEqual({});
    expect(newNoteContext({ kind: "tag", value: "idea" }, types)).toEqual({ tag: "idea" });
    expect(newNoteContext({ kind: "type", value: "contact" }, types)).toEqual({ type: "contact" });
    expect(newNoteContext({ kind: "folder", value: "Journal" }, types)).toEqual({ folder: "Journal" });
  });

  it("uses the type that claims the folder, and the closest one when several do", () => {
    expect(newNoteContext({ kind: "folder", value: "Meetings/2026" }, types)).toEqual({ folder: "Meetings/2026", type: "meeting" });
    expect(newNoteContext({ kind: "folder", value: "Meetings-old" }, types)).toEqual({ folder: "Meetings-old" });
    const review: CollectionTypeDescriptor = { name: "review", extensions: {}, definition: { match: { path_glob: "Meetings/Reviews/*.md" } }, schema: {} };
    expect(newNoteContext({ kind: "folder", value: "Meetings/Reviews" }, [...types, review]).type).toBe("review");
  });

  it("uses the type a tag alone puts a note under", () => {
    const tagged = (match: CollectionTypeDescriptor["definition"]): CollectionTypeDescriptor => ({ name: "task", extensions: {}, definition: { match }, schema: {} });
    const task = tagged({ where: { tags: { contains: "task" } } });
    expect(newNoteContext({ kind: "tag", value: "task" }, [...types, task])).toEqual({ tag: "task", type: "task" });
    expect(newNoteContext({ kind: "tag", value: "idea" }, [...types, task])).toEqual({ tag: "idea" });
    // A match that asks for more than the tag is not decided by the tag.
    expect(newNoteContext({ kind: "tag", value: "task" }, [tagged({ path_glob: "Tasks/*.md", where: { tags: { contains: "task" } } })])).toEqual({ tag: "task" });
    expect(newNoteContext({ kind: "tag", value: "task" }, [tagged({ where: { tags: { contains: "task" }, status: "open" } })])).toEqual({ tag: "task" });
    expect(newNoteContext({ kind: "tag", value: "task" }, [tagged({ where: { tags: { contains: "task", exists: true } } })])).toEqual({ tag: "task" });
    expect(newNoteContext({ kind: "tag", value: "task" }, [tagged({ where: { tags: "task" } })])).toEqual({ tag: "task" });
  });

  it("starts a note from a claimed tag with the type's required fields and the tag", () => {
    const task: CollectionTypeDescriptor = {
      name: "task",
      extensions: {},
      definition: { match: { where: { tags: { contains: "task" } } } },
      schema: { type: "object", required: ["status", "due"], properties: { status: { type: "string", default: "open" }, due: { type: "string", format: "date" } } }
    };
    const note = beginNewNote(newNoteContext({ kind: "tag", value: "task" }, [task]), [task]);
    expect(note).toMatchObject({ type: "task", properties: { status: "open", tags: ["task"], due: "" } });
    expect(newNoteBlocker({ ...note, title: "Call the plumber" }, newNoteForm("task", [task]))).toBe("Fill in the required properties.");
  });
});

describe("a new note", () => {
  it("starts with its type's defaults, the list's tag and an empty value for each required field", () => {
    const note = beginNewNote({ type: "meeting", tag: "weekly" }, types);
    expect(note).toMatchObject({ type: "meeting", title: "", body: "", propertiesValid: true });
    expect(note.properties).toEqual({ type: "meeting", status: "planned", tags: ["weekly"], date: "" });
    expect(note.initialProperties).toEqual(note.properties);
  });

  it("starts from given properties over the type's own", () => {
    const note = beginNewNote({ type: "contact", title: "Ada", properties: { name: "Ada", uid: "person_1" } }, types);
    expect(note.properties).toEqual({ type: "contact", name: "Ada", uid: "person_1" });
  });

  it("has nothing to keep until it has a title, a body or a changed property", () => {
    const note = beginNewNote({ type: "meeting" }, types);
    expect(newNoteStarted(note)).toBe(false);
    expect(newNoteStarted({ ...note, title: "  " })).toBe(false);
    expect(newNoteStarted({ ...note, title: "Planning" })).toBe(true);
    expect(newNoteStarted({ ...note, body: "Agenda" })).toBe(true);
    expect(newNoteStarted({ ...note, properties: { ...note.properties, date: "2026-11-11" } })).toBe(true);
  });

  it("is the same note when an edit changes nothing", () => {
    const note = beginNewNote({}, types);
    expect(changedNewNote(note, { propertiesValid: true, title: "" })).toBe(note);
    expect(changedNewNote(note, { title: "Changed" })).toEqual({ ...note, title: "Changed" });
  });
});

describe("what a type asks of a new note", () => {
  it("asks for required fields the type does not supply itself", () => {
    const form = newNoteForm("meeting", types);
    expect(form.required).toEqual(["date"]);
    expect(form.titleField).toBeUndefined();
    expect(form.requiredTitle).toBeUndefined();
  });

  it("leaves the fields the type sets on creation to the type", () => {
    const task: CollectionTypeDescriptor = {
      name: "task",
      extensions: {},
      lifecycle: { on_create: [{ if: "!has(raw.dateCreated)", set: { dateCreated: { now: true } } }, { set: { "/dateModified": { now: true } } }] },
      schema: {
        type: "object",
        required: ["type", "status", "dateCreated", "dateModified", "due"],
        properties: {
          type: { const: "task" },
          status: { type: "string", default: "open" },
          dateCreated: { type: "string", format: "date-time" },
          dateModified: { type: "string", format: "date-time" },
          due: { type: "string", format: "date" }
        }
      }
    };
    expect(newNoteForm("task", [task]).required).toEqual(["due"]);
    expect(beginNewNote({ type: "task" }, [task]).properties).toEqual({ type: "task", status: "open", due: "" });
  });

  it("reads a single on_create rule as well as a list of them", () => {
    // TaskNotes' task type as production has it: one rule, and a title that is the note's name.
    const task: CollectionTypeDescriptor = {
      name: "task",
      extensions: {},
      collection: { display: { name_field: "title" } },
      definition: { match: { where: { tags: { contains: "task" } } } },
      lifecycle: { on_create: { set: { id: { uuid: true }, dateCreated: { now: true }, dateModified: { now: true } } }, on_update: { set: { dateModified: { now: true } } } },
      schema: {
        type: "object",
        required: ["title", "status", "dateCreated"],
        properties: {
          id: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          status: { enum: ["open", "done"], default: "open" },
          dateCreated: { type: "string", format: "date-time" },
          dateModified: { type: "string", format: "date-time" }
        }
      }
    };
    const form = newNoteForm("task", [task]);
    expect(form.required).toEqual([]);
    const note = { ...beginNewNote(newNoteContext({ kind: "tag", value: "task" }, [task]), [task]), title: "Call the plumber" };
    expect(note.properties).toEqual({ status: "open", tags: ["task"] });
    expect(newNoteBlocker(note, form)).toBeUndefined();
  });

  it("puts the title in the declared name field and asks for nothing else", () => {
    const form = newNoteForm("contact", types);
    expect(form).toMatchObject({ titleField: "name", titleLabel: "Name", requiredTitle: "Name", required: [] });
    expect(Object.keys(form.properties)).toEqual(["tags"]);
  });

  it("asks nothing of a note without a type", () => {
    const general = newNoteForm(undefined, types);
    expect(general).toMatchObject({ required: [], properties: {} });
    expect(general.requiredTitle).toBeUndefined();
  });

  it("says what is missing before the note can be written", () => {
    const meetingForm = newNoteForm("meeting", types);
    const draft = { ...beginNewNote({ type: "meeting" }, types), title: "Planning" };
    expect(newNoteBlocker(draft, meetingForm)).toBe("Fill in the required properties.");
    const dated = { ...draft, properties: { ...draft.properties, date: "2026-11-11" } };
    expect(newNoteBlocker(dated, meetingForm)).toBeUndefined();
    expect(newNoteBlocker({ ...dated, propertiesValid: false }, meetingForm)).toBe("Fix the highlighted property values.");

    const contactForm = newNoteForm("contact", types);
    const person = { ...beginNewNote({ type: "contact" }, types), body: "Met at the conference." };
    expect(newNoteBlocker(person, contactForm)).toBe("Name is needed to save this note.");
    expect(newNoteBlocker({ ...person, title: "Ada Lovelace" }, contactForm)).toBeUndefined();
  });
});

describe("where a new note is written", () => {
  const general = newNoteForm(undefined, types);

  it("is named from its title, in the list's folder or its type's", () => {
    expect(newNotePath({ title: "Trip ideas" }, general, occupiedPaths([]))).toBe("Trip ideas.md");
    expect(newNotePath({ title: "Trip ideas", folder: "Journal/2026" }, general, occupiedPaths([]))).toBe("Journal/2026/Trip ideas.md");
    expect(newNotePath({ title: "Planning" }, newNoteForm("meeting", types), occupiedPaths([]))).toBe("Meetings/Planning.md");
    expect(newNotePath({ title: "Planning", folder: "" }, newNoteForm("meeting", types), occupiedPaths([]))).toBe("Planning.md");
  });

  it("is Untitled until it has a title", () => {
    expect(newNotePath({ title: "  " }, general, occupiedPaths([]))).toBe("Untitled.md");
  });

  it("keeps off every path in use, whatever its case", () => {
    const occupied = occupiedPaths(["untitled.md", "Untitled (2).md", "Journal/Trip Ideas.md"]);
    expect(newNotePath({ title: "" }, general, occupied)).toBe("Untitled (3).md");
    expect(newNotePath({ title: "Trip ideas", folder: "Journal" }, general, occupied)).toBe("Journal/Trip ideas (2).md");
  });

  it("replaces the characters file systems refuse", () => {
    expect(newNotePath({ title: " What/why: a  plan? " }, general, occupiedPaths([]))).toBe("What-why- a plan-.md");
    expect(newNotePath({ title: "..hidden" }, general, occupiedPaths([]))).toBe("hidden.md");
  });

  it("creates the note under its own id, with the title in the type's name field", () => {
    const note = { ...beginNewNote({ type: "contact", tag: "friend" }, types), title: " Ada Lovelace ", body: "Notes" };
    expect(newNoteInput(note, newNoteForm("contact", types), occupiedPaths([]))).toEqual({
      id: note.id,
      title: "Ada Lovelace",
      body: "Notes",
      path: "Ada Lovelace.md",
      type: "contact",
      titleField: "name",
      properties: { type: "contact", tags: ["friend"], name: "Ada Lovelace" }
    });
  });
});

describe("naming an untitled note", () => {
  it("takes the first title it is given, in the folder it is already in", () => {
    expect(titledPath("Untitled.md", "Trip ideas", occupiedPaths(["Untitled.md"]))).toBe("Trip ideas.md");
    expect(titledPath("Journal/Untitled (2).md", "Trip ideas", occupiedPaths(["Journal/trip ideas.md"]))).toBe("Journal/Trip ideas (2).md");
  });

  it("leaves a note that has a name of its own, or still has no title", () => {
    expect(titledPath("Journal/trip-ideas.md", "Trip ideas", occupiedPaths([]))).toBeUndefined();
    expect(titledPath("Untitled.md", "  ", occupiedPaths([]))).toBeUndefined();
    expect(titledPath("Untitled.md", "Untitled", occupiedPaths([]))).toBeUndefined();
  });
});
