import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollectionDescription, CollectionTypeDescriptor } from "@mdbase-dev/connect";
import type { LeaveIntent } from "@mdbase-dev/ui/collections";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CreateNoteInput, NoteDocument } from "./model";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ header, value, onChange, label, footer }: { header?: ReactNode; value: string; onChange?: (value: string) => void; label: string; footer?: ReactNode }) => <>{header}<textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />{footer}</> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

const meeting: CollectionTypeDescriptor = {
  name: "meeting",
  description: "A meeting and what was agreed.",
  extensions: {},
  definition: { match: { path_glob: "Meetings/**/*.md" } },
  schema: {
    type: "object",
    required: ["type", "agenda", "status"],
    properties: {
      type: { const: "meeting" },
      agenda: { type: "string" },
      status: { type: "string", enum: ["planned", "held"], default: "planned" }
    }
  }
};

/** A type a tag alone puts a note under, as TaskNotes' task type does. */
const idea: CollectionTypeDescriptor = {
  name: "idea",
  extensions: {},
  definition: { match: { where: { tags: { contains: "ideas" } } } },
  schema: {
    type: "object",
    required: ["source"],
    properties: { source: { type: "string" }, tags: { type: "array", items: { type: "string" } } }
  }
};

/** The demo collection with a type that asks for a field before a note of it can be written. */
class MeetingsGateway extends DemoCollectionGateway {
  async describe(): Promise<CollectionDescription> {
    const description = await super.describe();
    return { ...description, types: [...description.types, meeting] };
  }
}

/** A type that requires a field its own lifecycle sets when the note is created, as TaskNotes' task type does. */
const stamped: CollectionTypeDescriptor = {
  name: "stamped",
  extensions: {},
  definition: { match: { where: { tags: { contains: "ideas" } } } },
  lifecycle: { on_create: { set: { dateCreated: { now: true } } } },
  schema: {
    type: "object",
    required: ["dateCreated"],
    properties: { dateCreated: { type: "string", format: "date-time" }, tags: { type: "array", items: { type: "string" } } }
  }
};

class StampedGateway extends DemoCollectionGateway {
  async describe(): Promise<CollectionDescription> {
    const description = await super.describe();
    return { ...description, types: [...description.types, stamped] };
  }
}

class IdeasGateway extends DemoCollectionGateway {
  async describe(): Promise<CollectionDescription> {
    const description = await super.describe();
    return { ...description, types: [...description.types, idea] };
  }
}

async function openEditor(gateway: DemoCollectionGateway = new DemoCollectionGateway(4)) {
  const user = userEvent.setup();
  render(<App gateway={gateway} />);
  await within(await screen.findByRole("region", { name: "Notes and files" })).findByRole("heading", { name: "All notes" });
  await screen.findByRole("textbox", { name: "Note body" });
  return user;
}

const noteTitle = () => screen.getByRole("textbox", { name: "Note title" });
const noteBody = () => screen.getByRole("textbox", { name: "Note body" });
/** Where an unsaved note will be written, as the editor bar shows it. */
const pendingPath = () => document.querySelector(".note-path-pending")?.getAttribute("title");
const unsavedNotes = () => screen.queryByRole("group", { name: "Notes not saved yet" });

async function startNote(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New note" }));
  await waitFor(() => expect(noteTitle()).toHaveValue(""));
}

async function startNoteOfType(user: ReturnType<typeof userEvent.setup>, type: RegExp) {
  await user.click(screen.getByRole("button", { name: "New note of type…" }));
  const picker = await screen.findByRole("dialog", { name: "New note" });
  await user.click(within(picker).getByRole("option", { name: type }));
  await waitFor(() => expect(noteTitle()).toHaveValue(""));
}

describe("a new note", () => {
  it("opens empty in the editor and is written when its title is left", async () => {
    const gateway = new DemoCollectionGateway(4);
    const create = vi.spyOn(gateway, "create");
    const user = await openEditor(gateway);

    await startNote(user);
    expect(noteTitle()).toHaveFocus();
    expect(pendingPath()).toBe("Untitled.md");
    expect(within(screen.getByRole("main", { name: "Note editor" })).getByRole("status")).toHaveTextContent("Not saved yet");
    expect(within(unsavedNotes()!).getByRole("button", { name: /Untitled/ })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: "Create note" })).not.toBeInTheDocument();

    const body = noteBody();
    await user.type(noteTitle(), "A useful note");
    expect(pendingPath()).toBe("A useful note.md");
    expect(create).not.toHaveBeenCalled();
    await user.tab();

    expect(await screen.findByRole("button", { name: "A useful note.md" })).toBeInTheDocument();
    expect(unsavedNotes()).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /A useful note/ })).toBeInTheDocument();
    // The editor the note was started in is the saved note's editor: the caret stays where it was.
    expect(noteBody()).toBe(body);
    expect(body).toHaveFocus();
    await user.type(body, "The opening paragraph is already here.");
    await waitFor(async () => expect((await gateway.read("A useful note.md")).body).toBe("# A useful note\n\nThe opening paragraph is already here."));
    expect((await gateway.read("A useful note.md")).types).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("is written as Untitled when the body comes first, and named once by its first title", async () => {
    const gateway = new DemoCollectionGateway(4);
    const rename = vi.spyOn(gateway, "rename");
    const user = await openEditor(gateway);

    await startNote(user);
    await user.type(noteBody(), "Captured before it had a name.");
    expect(await screen.findByRole("button", { name: "Untitled.md" })).toBeInTheDocument();
    await waitFor(async () => expect((await gateway.read("Untitled.md")).body).toBe("Captured before it had a name."));
    expect(noteTitle()).toHaveValue("");

    await user.type(noteTitle(), "Named later");
    await user.tab();
    expect(await screen.findByRole("button", { name: "Named later.md" })).toBeInTheDocument();
    await waitFor(async () => expect((await gateway.read("Named later.md")).body).toBe("# Named later\n\nCaptured before it had a name."));
    await expect(gateway.read("Untitled.md")).rejects.toThrow();

    await user.type(noteTitle(), " on");
    await user.tab();
    await waitFor(async () => expect((await gateway.read("Named later.md")).body).toBe("# Named later on\n\nCaptured before it had a name."));
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("is put away without a question while it is empty", async () => {
    const gateway = new DemoCollectionGateway(4);
    const create = vi.spyOn(gateway, "create");
    const user = await openEditor(gateway);
    const opened = noteTitle().getAttribute("value") ?? (noteTitle() as HTMLTextAreaElement).value;

    await startNote(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(noteTitle()).toHaveValue(opened));
    expect(unsavedNotes()).not.toBeInTheDocument();

    await startNote(user);
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(noteTitle()).toHaveValue("Garden notes 2"));
    expect(unsavedNotes()).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("takes the type chosen in the picker, with the fields the type requires under the title", async () => {
    const gateway = new MeetingsGateway(4);
    const create = vi.spyOn(gateway, "create");
    const user = await openEditor(gateway);

    await user.click(screen.getByRole("button", { name: "New note of type…" }));
    const picker = await screen.findByRole("dialog", { name: "New note" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("General note"), expect.stringContaining("note"), expect.stringContaining("meeting")
    ]);
    await user.click(within(picker).getByRole("option", { name: /meeting/i }));
    await waitFor(() => expect(noteTitle()).toHaveValue(""));
    expect(pendingPath()).toBe("Meetings/Untitled.md");

    await user.type(noteTitle(), "Planning");
    const required = screen.getByRole("region", { name: "Required properties" });
    const agenda = within(required).getByRole("textbox", { name: "agenda value" });
    await user.click(noteBody());
    expect(within(screen.getByRole("main", { name: "Note editor" })).getByText("Fill in the required properties.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.type(agenda, "Budget");
    await user.click(noteBody());
    expect(await screen.findByRole("button", { name: "Meetings/Planning.md" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Required properties" })).not.toBeInTheDocument();
    const created = await gateway.read("Meetings/Planning.md");
    expect(created.types).toEqual(["meeting"]);
    expect(created.frontmatter).toEqual({ type: "meeting", status: "planned", agenda: "Budget" });
  });

  it("asks for the required fields of the type a tag list's tag puts the note under", async () => {
    const gateway = new IdeasGateway(12);
    const create = vi.spyOn(gateway, "create");
    const user = await openEditor(gateway);
    await user.type(screen.getByRole("combobox", { name: "Search notes and files" }), "#ideas{Enter}");
    expect(screen.getByRole("heading", { name: "#ideas" })).toBeInTheDocument();

    await startNote(user);
    await user.type(noteTitle(), "Shared drafts");
    await user.tab();
    // The runtime would refuse this note as an idea without a source: it waits for one instead of failing.
    const required = await screen.findByRole("region", { name: "Required properties" });
    expect(screen.getByText("Fill in the required properties.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry save" })).not.toBeInTheDocument();

    await user.type(within(required).getByRole("textbox", { name: "source value" }), "Standup");
    await user.click(noteBody());
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ type: "idea", path: "Shared drafts.md", properties: { tags: ["ideas"], source: "Standup" } });
    await waitFor(() => expect(unsavedNotes()).not.toBeInTheDocument());
  });

  it("is written without asking for a required field the type sets when the note is created", async () => {
    const gateway = new StampedGateway(12);
    const create = vi.spyOn(gateway, "create");
    const user = await openEditor(gateway);
    await user.type(screen.getByRole("combobox", { name: "Search notes and files" }), "#ideas{Enter}");

    await startNote(user);
    expect(screen.queryByRole("region", { name: "Required properties" })).not.toBeInTheDocument();
    await user.type(noteTitle(), "Stamped on arrival");
    await user.tab();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({ type: "stamped", path: "Stamped on arrival.md", properties: { tags: ["ideas"] } });
    // The field is left out, not sent empty: the runtime's rule fills it.
    expect(input.properties).not.toHaveProperty("dateCreated");
    await waitFor(() => expect(unsavedNotes()).not.toBeInTheDocument());
  });

  it("stays in the list as a draft while it can't be saved, and is discarded only on request", async () => {
    const gateway = new MeetingsGateway(4);
    const create = vi.spyOn(gateway, "create");
    const user = await openEditor(gateway);

    await startNoteOfType(user, /meeting/i);
    await user.type(noteTitle(), "Planning");
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(noteTitle()).toHaveValue("Garden notes 2"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const draft = within(unsavedNotes()!).getByRole("button", { name: /Planning/ });
    expect(draft).toHaveTextContent("Not saved yet");

    await user.click(draft);
    await waitFor(() => expect(noteTitle()).toHaveValue("Planning"));
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Discard note" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Discard this note?" })).getByRole("button", { name: "Discard note" }));
    await waitFor(() => expect(unsavedNotes()).not.toBeInTheDocument());
    expect(create).not.toHaveBeenCalled();
  });

  it("takes the next free name when its file name was taken behind the list", async () => {
    class RacingGateway extends DemoCollectionGateway {
      raced = false;
      async create(input: CreateNoteInput): Promise<NoteDocument> {
        if (!this.raced) {
          this.raced = true;
          await super.create({ title: "Trip", body: "From another device.", path: input.path, properties: {} });
        }
        return super.create(input);
      }
    }
    const gateway = new RacingGateway(4);
    const user = await openEditor(gateway);

    await startNote(user);
    await user.type(noteTitle(), "Trip");
    await user.tab();
    expect(await screen.findByRole("button", { name: "Trip (2).md" })).toBeInTheDocument();
    expect(noteTitle()).toHaveValue("Trip");
    expect((await gateway.read("Trip.md")).body).toBe("# Trip\n\nFrom another device.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps what was written and offers a retry when it can't be created", async () => {
    const gateway = new DemoCollectionGateway(4);
    const create = vi.spyOn(gateway, "create").mockRejectedValueOnce(new Error("The collection could not be reached."));
    const user = await openEditor(gateway);

    await startNote(user);
    await user.type(noteTitle(), "Trip");
    await user.tab();
    expect(await screen.findByText("Couldn’t create “Trip.md”. The collection could not be reached.")).toBeInTheDocument();
    expect(within(unsavedNotes()!).getByRole("button", { name: /Trip/ })).toHaveTextContent("Needs attention");
    await user.type(noteBody(), "Still here.");
    expect(create).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Retry save" }));
    expect(await screen.findByRole("button", { name: "Trip.md" })).toBeInTheDocument();
    expect((await gateway.read("Trip.md")).body).toBe("# Trip\n\nStill here.");
    expect(unsavedNotes()).not.toBeInTheDocument();
  });

  it("is saved before the collection is switched, and asked about only when it can't be", async () => {
    const gateway = new MeetingsGateway(2);
    const user = userEvent.setup();
    let beforeLeave: ((intent: LeaveIntent) => boolean | Promise<boolean>) | undefined;
    render(<App gateway={gateway} collectionSwitcher={(onBeforeLeave) => { beforeLeave = onBeforeLeave; return <span>Shared switcher</span>; }} />);
    await within(await screen.findByRole("region", { name: "Notes and files" })).findByRole("heading", { name: "All notes" });
    await screen.findByRole("textbox", { name: "Note body" });
    expect(within(screen.getByRole("complementary", { name: "Collection navigation" })).getByText("Shared switcher")).toBeInTheDocument();
    await expect(Promise.resolve(beforeLeave?.("switch"))).resolves.toBe(true);

    await startNote(user);
    await user.type(noteTitle(), "Half written");
    let leaving!: Promise<boolean>;
    act(() => { leaving = Promise.resolve(beforeLeave?.("switch") ?? true); });
    await expect(leaving).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect((await gateway.read("Half written.md")).body).toBe("# Half written\n");

    await startNoteOfType(user, /meeting/i);
    await user.type(noteTitle(), "Planning");
    act(() => { leaving = Promise.resolve(beforeLeave?.("switch") ?? true); });
    const dialog = await screen.findByRole("alertdialog", { name: "Switch collections?" });
    expect(dialog).toHaveTextContent("The note that hasn’t been saved will be discarded.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await expect(leaving).resolves.toBe(false);
    expect(noteTitle()).toHaveValue("Planning");
    act(() => { leaving = Promise.resolve(beforeLeave?.("switch") ?? true); });
    await user.click(within(await screen.findByRole("alertdialog", { name: "Switch collections?" })).getByRole("button", { name: "Switch collection" }));
    await expect(leaving).resolves.toBe(true);
  });
});
