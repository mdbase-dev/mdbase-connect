import { act, fireEvent, render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import type { CollectionTypeDescriptor } from "./connect-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteDocument } from "./model";
import { PropertiesPanel } from "./PropertiesPanel";
import { schemaDateInputValue } from "./schema-date";
import { chooseOption } from "./test/select";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, onBlur, label, readOnly }: { value: string; onChange?: (value: string) => void; onBlur?: () => void; label: string; readOnly?: boolean }) =>
    <textarea aria-label={label} value={value} readOnly={readOnly} onChange={(event) => onChange?.(event.target.value)} onBlur={onBlur} />
}));

vi.mock("./DeferredCodeEditor", async () => ({
  DeferredCodeEditor: (await import("./CodeEditor")).CodeEditor
}));

afterEach(() => vi.useRealTimers());

describe("typed note properties", () => {
  it("shows values that are not what the type says and saves only once each is put right", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const note = { ...eventNote, frontmatter: { rating: 49, tags: "original", title: "Before" } };
    const type = { ...eventType, schema: { type: "object", properties: {
      rating: { type: "string" }, tags: { type: "array", items: { type: "string" } }, title: { type: "string" }
    } } };
    const view = render(<PropertiesPanel note={note} types={[type]} onClose={vi.fn()} onSave={onSave} />);
    const rating = screen.getByRole("textbox", { name: "rating" });
    expect(rating).toHaveValue("49");
    expect(screen.getByRole("button", { name: "Remove original" })).toBeVisible();
    expect(screen.getByText("Enter text.")).toBeVisible();
    expect(screen.getByText("Enter a list.")).toBeVisible();
    commit(screen.getByRole("textbox", { name: "title" }), "After");
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(onSave).not.toHaveBeenCalled();
    // Enter says the number is right as the text it reads as.
    rating.focus();
    fireEvent.keyDown(rating, { key: "Enter" });
    expect(screen.queryByText("Enter text.")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(onSave).not.toHaveBeenCalled();
    const tags = screen.getByRole("textbox", { name: "tags" });
    fireEvent.change(tags, { target: { value: "next" } });
    fireEvent.keyDown(tags, { key: "Enter" });
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(note.path, { rating: "49", tags: ["original", "next"], title: "After" });
    view.unmount();
  });

  it("keeps the keyboard in a field being retyped and saves nothing until it is left", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const note = { ...eventNote, frontmatter: { rating: 49 } };
    render(<PropertiesPanel note={note}
      types={[{ ...eventType, schema: { type: "object", properties: { rating: { type: "string" } } } }]}
      onClose={vi.fn()} onSave={onSave} />);
    const rating = screen.getByRole("textbox", { name: "rating" });
    rating.focus();
    fireEvent.change(rating, { target: { value: "" } });
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(rating).toHaveFocus();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(rating, { target: { value: "49 stars" } });
    expect(rating).toHaveFocus();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.blur(rating);
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(note.path, { rating: "49 stars" });
  });

  it("shows and corrects a mismatched nullable scalar", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const note = { ...eventNote, frontmatter: { rating: 49 } };
    render(<PropertiesPanel note={note}
      types={[{ ...eventType, schema: { type: "object", properties: { rating: { type: ["string", "null"] } } } }]}
      onClose={vi.fn()} onSave={onSave} />);
    const rating = screen.getByRole("textbox", { name: "rating" });
    expect(rating).toHaveValue("49");
    expect(screen.getByText("Enter text.")).toBeVisible();
    rating.focus();
    fireEvent.keyDown(rating, { key: "Enter" });
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(note.path, { rating: "49" });
  });

  it("saves again once a field that was wrong is emptied", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const note = { ...eventNote, frontmatter: { rating: 49, title: "Before" } };
    render(<PropertiesPanel note={note}
      types={[{ ...eventType, schema: { type: "object", properties: { rating: { type: "string" }, title: { type: "string" } } } }]}
      onClose={vi.fn()} onSave={onSave} />);
    commit(screen.getByRole("textbox", { name: "rating" }), "");
    expect(screen.queryByText("Enter text.")).toBeNull();
    commit(screen.getByRole("textbox", { name: "title" }), "After");
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenCalledExactlyOnceWith(note.path, { title: "After" });
  });

  it("never saves on closing while a field is still wrong", async () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    const view = render(<PropertiesPanel note={{ ...eventNote, frontmatter: { rating: 49, title: "Before" } }}
      types={[{ ...eventType, schema: { type: "object", properties: { rating: { type: "string" }, title: { type: "string" } } } }]}
      onClose={vi.fn()} onSave={onSave} />);
    commit(screen.getByRole("textbox", { name: "title" }), "After");
    view.unmount();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("omits unavailable filesystem facts without treating frontmatter as file metadata", () => {
    const { container } = render(<PropertiesPanel note={{ ...eventNote, file: {},
      frontmatter: { dateModified: "2026-10-13T16:00:00Z" } }} types={[]} onClose={vi.fn()} onSave={vi.fn()} />);
    const facts = within(container.querySelector(".file-facts") as HTMLElement);
    expect(facts.getByText("Words")).toBeVisible();
    expect(facts.queryByText("Size")).toBeNull();
    expect(facts.queryByText("Modified")).toBeNull();
    expect(facts.queryByText("Unknown")).toBeNull();
  });

  it("shows available zero-byte size and valid modification time", () => {
    const { container } = render(<PropertiesPanel note={{ ...eventNote,
      file: { ...eventNote.file!, size: 0, mtime: "2026-10-13T16:00:00Z" } }} types={[]} onClose={vi.fn()} onSave={vi.fn()} />);
    const facts = within(container.querySelector(".file-facts") as HTMLElement);
    expect(facts.getByText("Size").nextElementSibling).toHaveTextContent("0 B");
    expect(facts.getByText("Modified").nextElementSibling).not.toHaveTextContent("Unknown");
  });

  it("keeps property saves silent until slow, leaves the keyboard where it is, and retries failures", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const onSave = vi.fn().mockImplementationOnce(() => new Promise<void>((_done, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const view = render(<PropertiesPanel note={eventNote} types={[eventType]} body="Forty two words would be a lot to write out here." onClose={() => {}} onSave={onSave} />);
    expect(screen.getByText("Words").nextElementSibling).toHaveTextContent("11");
    const input = moment("starts_at");
    commit(input, "2026-07-23T09:45:00");
    // The save starts after the field is left; the keyboard is by then in the next thing.
    const next = screen.getByRole("button", { name: /^event_date: / });
    next.focus();
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".property-save-state")).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(1_499));
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(next).toHaveFocus();
    await act(async () => reject(new Error("Offline")));
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    expect(next).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.container.querySelector(".property-save-state")).toBeEmptyDOMElement();
  });

  it("keeps healthy source saves silent and a failed source actionable", async () => {
    const onSaveDocument = vi.fn().mockResolvedValue(false);
    const view = render(<PropertiesPanel note={sourceNote} types={[]} onClose={() => {}} onSave={async () => {}} onSaveDocument={onSaveDocument} />);
    fireEvent.click(screen.getByRole("button", { name: "Property options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit as source" }));
    expect(view.container.querySelector(".property-save-state")).toBeEmptyDOMElement();
    const source = screen.getByLabelText("Complete record source");
    fireEvent.change(source, { target: { value: "Edited source" } });
    fireEvent.blur(source);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your edits are still here");
    expect(screen.getByRole("button", { name: "Save source" })).toBeEnabled();
    expect(source).toHaveValue("Edited source");
  });

  it("keeps source in the options menu and cycles only between property formats", async () => {
    const user = userEvent.setup();
    render(<PropertiesPanel note={{ ...eventNote, frontmatter: {}, types: [] }} types={[]} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText(/Add a property to keep details/)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Source" })).not.toBeInTheDocument();
    const fields = screen.getByRole("tab", { name: "Fields" });
    fields.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Advanced" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(fields).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Property options" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit as source" }));
    expect(screen.getByRole("region", { name: "Record source" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Property options" }));
    await user.click(screen.getByRole("menuitem", { name: "Back to fields" }));
    expect(fields).toHaveAttribute("aria-selected", "true");
  });

  it("visibly rejects structured, JSON, source, and autosave edits while frozen", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onSaveDocument = vi.fn();
    render(<PropertiesPanel note={eventNote} types={[eventType]} readOnly onClose={() => undefined}
      onSave={onSave} onSaveDocument={onSaveDocument} />);
    // The fields are only shown: nothing to type into, add or take off.
    const fields = within(screen.getByRole("tabpanel"));
    expect(fields.getByText("Jul 21, 2026")).toBeVisible();
    expect(fields.queryByRole("textbox")).toBeNull();
    expect(fields.queryByRole("button")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByLabelText("Raw frontmatter JSON")).toHaveAttribute("readonly");
    fireEvent.change(screen.getByLabelText("Raw frontmatter JSON"), { target: { value: "{}" } });
    await user.click(screen.getByRole("button", { name: "Property options" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit as source" }));
    expect(screen.getByLabelText("Complete record source")).toHaveAttribute("readonly");
    fireEvent.blur(screen.getByLabelText("Complete record source"));
    expect(screen.getByRole("button", { name: "Save source" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
    expect(onSaveDocument).not.toHaveBeenCalled();
  });

  it("edits a day with the date picker and a moment with the browser's date and time control", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={eventNote} types={[eventType]} onClose={() => undefined} onSave={onSave} />);

    const startsAt = moment("starts_at");
    expect(startsAt).toHaveAttribute("type", "datetime-local");
    expect(startsAt.value).toContain(schemaDateInputValue("2026-07-21T05:15:30.000Z", "date-time"));
    await user.click(screen.getByRole("button", { name: "event_date: Jul 21, 2026" }));
    await user.type(within(screen.getByRole("dialog", { name: "event_date" })).getByRole("textbox"), "2026-07-23{Enter}");
    expect(screen.getByRole("button", { name: "event_date: Jul 23, 2026" })).toBeVisible();
    commit(startsAt, "2026-07-23T09:45:00");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Events/planning.md", {
      event_date: "2026-07-23",
      starts_at: new Date("2026-07-23T09:45:00").toISOString()
    }), { timeout: 1_500 });
  });

  it("describes a field that may be a day or a moment as the one it holds", () => {
    const either = { anyOf: [{ type: "string", format: "date" }, { type: "string", format: "date-time" }] };
    render(<PropertiesPanel note={{ ...eventNote, frontmatter: { due: "2026-07-21", scheduled: "2026-07-21T05:15:30.000Z" } }}
      types={[{ ...eventType, schema: { type: "object", properties: { due: either, scheduled: either } } }]} onClose={() => undefined} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "due: Jul 21, 2026" })).toBeVisible();
    expect(moment("scheduled")).toHaveAttribute("type", "datetime-local");
  });

  it("edits the parts of nested values and lists in place", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={contactNote} types={[contactType]} onClose={() => undefined} onSave={onSave} />);

    const name = screen.getByRole("textbox", { name: "profile display_name" });
    await user.clear(name);
    await user.type(name, "Ada Byron{Enter}");
    expect(screen.getByRole("button", { name: "contacts 1: ada@example.com" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add item to contacts" }));
    // The new item has the parts it must have, and is wrong until they are filled in.
    expect(screen.getByRole("alert")).toBeVisible();
    await chooseOption(user, screen.getByRole("combobox", { name: "contacts 2 kind" }), "phone");
    await user.type(screen.getByRole("textbox", { name: "contacts 2 value" }), "+44 20 0000 0000{Enter}");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("People/ada.md", {
      profile: { display_name: "Ada Byron" },
      contacts: [
        { kind: "email", value: "ada@example.com" },
        { kind: "phone", value: "+44 20 0000 0000" }
      ]
    }), { timeout: 1_500 });
  });

  it("always shows a required field, says what it is for, and lists what the type provides", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<PropertiesPanel note={schemaLedNote} types={[schemaLedType]} onClose={() => undefined} onSave={onSave} />);

    const title = screen.getByRole("textbox", { name: "title" });
    expect(title).toHaveValue("");
    expect(screen.getByTitle("title: A human-readable title.")).toHaveTextContent("title*");
    expect(screen.getByTitle("Required")).toBeVisible();
    expect(screen.getByText("This required property is missing.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove title" })).toBeNull();
    const provided = within(screen.getByRole("region", { name: "Automatic properties" }));
    expect(provided.getByText("status")).toBeVisible();
    expect(provided.getByText("draft")).toBeVisible();
    expect(provided.queryByRole("combobox")).toBeNull();

    await user.type(title, "Ready{Enter}");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Notes/missing.md", { title: "Ready" }), { timeout: 1_500 });
  });

  it("validates inline and keeps the edited draft open after a failed save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockRejectedValue(new Error("Server rejected the record."));
    render(<PropertiesPanel note={invalidNote} types={[schemaLedType]} error="Server rejected the record." onClose={vi.fn()} onSave={onSave} />);

    const title = screen.getByRole("textbox", { name: "title" });
    await user.clear(title);
    await user.type(title, "ab{Enter}");
    expect(screen.getByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(screen.getByText("Fix invalid fields to continue saving")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    await user.clear(title);
    await user.type(title, "Edited title{Enter}");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Notes/invalid.md", { title: "Edited title", nullable: null }), { timeout: 1_500 });
    expect(screen.getByRole("textbox", { name: "title" })).toHaveValue("Edited title");
    expect(screen.getByRole("complementary", { name: "Note properties" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Property options" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit as source" }));
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

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
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

    await user.click(screen.getByRole("button", { name: "Property options" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit as source" }));
    const sourceEditor = screen.getByLabelText("Complete record source");
    const nextDocument = oldDocument.replace("custom: old", "custom: from-source");
    fireEvent.change(sourceEditor, { target: { value: nextDocument } });
    fireEvent.blur(sourceEditor);
    await waitFor(() => expect(onSaveDocument).toHaveBeenCalledWith(nextDocument, oldDocument));
    const fieldSaveCount = onSave.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    expect(onSave).toHaveBeenCalledTimes(fieldSaveCount);

    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.getByLabelText("Raw frontmatter JSON")).toHaveValue(JSON.stringify({
      title: "Quoted",
      custom: "from-source"
    }, null, 2));
  });
});

/** Types a value into a field and leaves it, which is when the list hands the value over. */
function commit(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

/** A field's date and time control, which has no role to ask for it by. */
function moment(field: string): HTMLInputElement {
  return screen.getByLabelText(field, { selector: 'input[type="datetime-local"]' });
}

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
