import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it, vi } from "vitest";
import type { NoteDocument } from "./model";
import { PropertiesPanel } from "./PropertiesPanel";
import { schemaDateInputValue } from "./schema-date";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, onBlur, label }: { value: string; onChange?: (value: string) => void; onBlur?: () => void; label: string }) =>
    <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} onBlur={onBlur} />
}));

describe("typed note properties", () => {
  it("edits date and date-time strings with native pickers", async () => {
    const onSave = vi.fn();
    render(<PropertiesPanel note={eventNote} types={[eventType]} onClose={() => undefined} onSave={onSave} />);

    const eventDate = screen.getByLabelText("event_date value");
    const startsAt = screen.getByLabelText("starts_at value");
    expect(eventDate).toHaveAttribute("type", "date");
    expect(eventDate).toHaveValue("2026-07-21");
    expect(startsAt).toHaveAttribute("type", "datetime-local");
    expect((startsAt as HTMLInputElement).value).toContain(schemaDateInputValue("2026-07-21T05:15:30.000Z", "date-time"));
    expect(screen.getAllByTitle("Defined by the mdbase schema")[0]).toHaveTextContent("Date");
    expect(screen.queryByLabelText("event_date property kind")).not.toBeInTheDocument();

    fireEvent.change(eventDate, { target: { value: "2026-07-23" } });
    fireEvent.change(startsAt, { target: { value: "2026-07-23T09:45:00" } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Events/planning.md", {
      event_date: "2026-07-23",
      starts_at: new Date("2026-07-23T09:45:00").toISOString()
    }), { timeout: 1_500 });
  });

  it("edits schema-defined nested objects and lists without raw JSON", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={contactNote} types={[contactType]} onClose={() => undefined} onSave={onSave} />);

    await user.clear(screen.getByLabelText("display_name"));
    await user.type(screen.getByLabelText("display_name"), "Ada Byron");
    const contacts = screen.getByRole("group", { name: "contacts value" });
    await user.click(within(contacts).getByRole("button", { name: "Add item" }));
    const kinds = screen.getAllByLabelText("kind");
    const values = screen.getAllByLabelText("value");
    await user.selectOptions(kinds[1], "phone");
    await user.type(values[1], "+44 20 0000 0000");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("People/ada.md", {
      profile: { display_name: "Ada Byron" },
      contacts: [
        { kind: "email", value: "ada@example.com" },
        { kind: "phone", value: "+44 20 0000 0000" }
      ]
    }), { timeout: 1_500 });
  });

  it("surfaces missing required fields, descriptions, defaults, and effective values", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={schemaLedNote} types={[schemaLedType]} onClose={() => undefined} onSave={onSave} />);

    const required = screen.getByRole("region", { name: "Missing required properties" });
    expect(within(required).getByText("A human-readable title.")).toBeInTheDocument();
    await user.click(within(required).getByRole("button", { name: /title/i }));
    expect(screen.getByLabelText("title value")).toHaveValue("");
    expect(screen.queryByLabelText("title property kind")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Computed and defaulted properties" })).toHaveTextContent("Default");

    await user.type(screen.getByLabelText("title value"), "Ready");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Notes/missing.md", { title: "Ready" }), { timeout: 1_500 });
  });

  it("validates inline and keeps the edited draft open after a failed save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("Server rejected the record."));
    render(<PropertiesPanel note={invalidNote} types={[schemaLedType]} error="Server rejected the record." onClose={vi.fn()} onSave={onSave} />);

    await user.clear(screen.getByLabelText("title value"));
    expect(screen.getByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(screen.getByText("Fix invalid fields to continue saving")).toBeInTheDocument();

    await user.type(screen.getByLabelText("title value"), "Edited title");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Notes/invalid.md", { title: "Edited title", nullable: null }), { timeout: 1_500 });
    expect(screen.getByLabelText("title value")).toHaveValue("Edited title");
    expect(screen.getByRole("complementary", { name: "Note properties" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Null" })).not.toBeInTheDocument();
  });

  it("shows and saves the complete exact record source", async () => {
    const user = userEvent.setup();
    const onSaveDocument = vi.fn(async (document: string) => ({
      ...sourceNote,
      document,
      body: document.slice(document.indexOf("---\n") + 4),
      revision: "revision-6"
    }));
    const onClose = vi.fn();
    render(<PropertiesPanel note={sourceNote} types={[]} onClose={onClose} onSave={async () => undefined} onSaveDocument={onSaveDocument} />);

    await user.click(screen.getByRole("tab", { name: "Source" }));
    const editor = screen.getByLabelText("Complete record source");
    const normalized = sourceNote.document!.replace(/\r\n/g, "\n");
    expect(editor).toHaveValue(normalized);
    fireEvent.change(editor, { target: { value: `${normalized}More.\n` } });
    fireEvent.blur(editor);
    await waitFor(() => expect(onSaveDocument).toHaveBeenCalledWith(`${normalized}More.\n`, sourceNote.document));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Note properties" })).toBeInTheDocument();

    onSaveDocument.mockClear();
    fireEvent.change(editor, { target: { value: `${normalized}More again.\n` } });
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(onSaveDocument).toHaveBeenCalledWith(`${normalized}More again.\n`, `${normalized}More.\n`));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rebases field drafts when an exact source save changes frontmatter", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    const oldDocument = "---\ntitle: Quoted\ncustom: old\n---\nBody\n";
    const noteWithFieldEdit = {
      ...sourceNote,
      frontmatter: { title: "Quoted", custom: "old" },
      effectiveFrontmatter: { title: "Quoted", custom: "old" },
      document: oldDocument,
      body: "Body\n",
      revision: "revision-fields"
    };
    const onSaveDocument = vi.fn(async (document: string): Promise<NoteDocument> => ({
      ...noteWithFieldEdit,
      frontmatter: { title: "Quoted", custom: "from-source" },
      effectiveFrontmatter: { title: "Quoted", custom: "from-source" },
      document,
      revision: "revision-source"
    }));
    const view = render(<PropertiesPanel
      note={sourceNote}
      types={[]}
      onClose={vi.fn()}
      onSave={onSave}
      onSaveDocument={onSaveDocument}
    />);

    await user.click(screen.getByRole("tab", { name: "JSON" }));
    fireEvent.change(screen.getByLabelText("Raw frontmatter JSON"), {
      target: { value: JSON.stringify(noteWithFieldEdit.frontmatter, null, 2) }
    });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(sourceNote.path, noteWithFieldEdit.frontmatter), { timeout: 1_500 });
    view.rerender(<PropertiesPanel
      note={noteWithFieldEdit}
      types={[]}
      onClose={vi.fn()}
      onSave={onSave}
      onSaveDocument={onSaveDocument}
    />);

    await user.click(screen.getByRole("tab", { name: "Source" }));
    const sourceEditor = screen.getByLabelText("Complete record source");
    const nextDocument = oldDocument.replace("custom: old", "custom: from-source");
    fireEvent.change(sourceEditor, { target: { value: nextDocument } });
    fireEvent.blur(sourceEditor);
    await waitFor(() => expect(onSaveDocument).toHaveBeenCalledWith(nextDocument, oldDocument));
    const fieldSaveCount = onSave.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    expect(onSave).toHaveBeenCalledTimes(fieldSaveCount);

    await user.click(screen.getByRole("tab", { name: "JSON" }));
    expect(screen.getByLabelText("Raw frontmatter JSON")).toHaveValue(JSON.stringify({
      title: "Quoted",
      custom: "from-source"
    }, null, 2));
  });
});

const eventType: CollectionTypeDescriptor = {
  name: "event",
  schema: {
    type: "object",
    properties: {
      event_date: { type: "string", format: "date" },
      starts_at: { type: "string", format: "date-time" }
    }
  },
  extensions: {}
};

const eventNote: NoteDocument = {
  path: "Events/planning.md",
  frontmatter: {
    event_date: "2026-07-21",
    starts_at: "2026-07-21T05:15:30.000Z"
  },
  effectiveFrontmatter: {
    event_date: "2026-07-21",
    starts_at: "2026-07-21T05:15:30.000Z"
  },
  body: "# Planning\n",
  types: ["event"],
  revision: "revision-1",
  file: { name: "planning.md", folder: "Events", size: 0, mtime: "" }
};

const contactType: CollectionTypeDescriptor = {
  name: "contact",
  schema: {
    type: "object",
    properties: {
      profile: {
        type: "object",
        required: ["display_name"],
        properties: { display_name: { type: "string" } }
      },
      contacts: {
        type: "array",
        items: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: { type: "string", enum: ["email", "phone"] },
            value: { type: "string" }
          }
        }
      }
    }
  },
  extensions: {}
};

const contactNote: NoteDocument = {
  path: "People/ada.md",
  frontmatter: {
    profile: { display_name: "Ada" },
    contacts: [{ kind: "email", value: "ada@example.com" }]
  },
  effectiveFrontmatter: {
    profile: { display_name: "Ada" },
    contacts: [{ kind: "email", value: "ada@example.com" }]
  },
  body: "# Ada\n",
  types: ["contact"],
  revision: "revision-2",
  file: { name: "ada.md", folder: "People", size: 0, mtime: "" }
};

const schemaLedType: CollectionTypeDescriptor = {
  name: "note",
  schema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string", minLength: 3, description: "A human-readable title." },
      status: { type: "string", enum: ["draft", "done"], default: "draft" },
      nullable: { type: ["string", "null"] }
    }
  },
  extensions: {}
};

const schemaLedNote: NoteDocument = {
  path: "Notes/missing.md",
  frontmatter: {},
  effectiveFrontmatter: { status: "draft" },
  body: "",
  types: ["note"],
  revision: "revision-3",
  file: { name: "missing.md", folder: "Notes", size: 0, mtime: "" }
};

const invalidNote: NoteDocument = {
  ...schemaLedNote,
  path: "Notes/invalid.md",
  frontmatter: { title: "Valid", nullable: null },
  effectiveFrontmatter: { title: "Valid", nullable: null, status: "draft" },
  revision: "revision-4"
};

const sourceNote: NoteDocument = {
  path: "Notes/source.md",
  frontmatter: { title: "Quoted" },
  effectiveFrontmatter: { title: "Quoted" },
  body: "Body  \r\n",
  document: "\u{feff}---\r\ntitle: \"Quoted\" # keep\r\n---\r\nBody  \r\n",
  types: [],
  revision: "revision-5",
  file: { name: "source.md", folder: "Notes", size: 0, mtime: "" }
};
