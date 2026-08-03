import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectOutcomeError, connectProblem, type CollectionChange, type DirectAccessStatus, type WatchStatus } from "@mdbase-dev/connect";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type {
  CollectionGateway,
  CollectionSessionSnapshot,
  ConnectionSummary,
  MutationOperationOptions,
  NoteContentRequest,
  NoteDocument,
  NoteIndexRequest,
  NoteIndexResult,
  NoteSummary
} from "./model";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) =>
    <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
  })
}));

describe("mdbase editor", () => {
  it("collapses, restores, and resizes both navigation sidebars", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(12)} />);

    await screen.findByRole("heading", { name: "Writing" });
    const collectionRail = screen.getByRole("complementary", { name: "Collection navigation" });
    expect(within(collectionRail).getByRole("status", { name: "Collection connected" })).toHaveTextContent("Connected");
    await user.click(within(collectionRail).getByRole("button", { name: "Switch collection, current collection Writing" }));
    expect(screen.getByRole("dialog", { name: "Choose a collection" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Forget/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close collection switcher" }));
    await user.click(screen.getByRole("button", { name: "Hide collections sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Collection navigation" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show collections sidebar" }));
    expect(screen.getByRole("complementary", { name: "Collection navigation" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide notes sidebar" }));
    expect(screen.queryByRole("region", { name: "Notes" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show notes sidebar" }));
    expect(screen.getByRole("region", { name: "Notes" })).toBeInTheDocument();

    const collectionResize = screen.getByRole("separator", { name: "Resize collections sidebar" });
    collectionResize.focus();
    await user.keyboard("{ArrowRight}");
    expect(collectionResize).toHaveAttribute("aria-valuenow", "184");
    expect(JSON.parse(localStorage.getItem("mdbase-editor:layout") ?? "null")).toMatchObject({
      collectionWidth: 184,
      collectionCollapsed: false,
      listCollapsed: false
    });

    await user.click(within(screen.getByRole("complementary", { name: "Collection navigation" })).getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Forget from this browser" }));
    expect(screen.getByRole("alertdialog", { name: "Forget “Writing” from this browser?" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("requests browser permission before using mdbase on this computer", async () => {
    const gateway = new DirectAccessGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const allow = await screen.findByRole("button", { name: "Use this computer" });
    expect(gateway.checkCalls).toBe(1);
    await user.click(allow);

    await waitFor(() => expect(gateway.requestCalls).toBe(1));
    expect(screen.queryByRole("button", { name: "Use this computer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByText("This computer", { selector: ".fact-row strong" })).toBeInTheDocument();
  });

  it("opens a collection, selects a note, and autosaves body changes", async () => {
    const gateway = new DemoCollectionGateway(12);
    const seeded = (await gateway.list()).notes[0]!;
    const original = await gateway.read(seeded.path);
    await gateway.updateProperties(original.path, { status: "draft" }, original.revision);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.type(body, "\nA saved sentence.");
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument(), { timeout: 2_000 });

    const first = (await gateway.list()).notes[0];
    const saved = await gateway.read(first.path);
    expect(saved.body).toContain("A saved sentence.");
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    expect(await screen.findByRole("textbox", { name: "status value" })).toHaveValue("draft");

    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(screen.getByRole("complementary", { name: "Note properties" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Note properties" })).getByText("Journal/garden-notes-2.md")).toBeInTheDocument();
  });

  it("previews notes from the virtualized sidebar after a deliberate hover", async () => {
    render(<App gateway={new DemoCollectionGateway(12)} />);

    await screen.findByRole("heading", { name: "Writing" });
    const row = screen.getAllByRole("option")[1] as HTMLButtonElement;
    const title = row.querySelector(".note-title")?.textContent;
    expect(title).toBeTruthy();

    fireEvent.mouseEnter(row);
    await waitFor(() => expect(document.querySelector(".note-preview")).not.toBeNull(), { timeout: 1_500 });
    const preview = screen.getByRole("tooltip");
    expect(preview).toHaveAccessibleName(/Preview of/);
    expect(preview.querySelector("header strong")?.textContent).toBeTruthy();
    expect(preview.querySelector("header span")?.textContent).toMatch(/\.md$/);
    expect(row).toHaveAttribute("aria-describedby", "note-preview-popover");

    fireEvent.mouseLeave(row);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("does not reload the collection index after saving one note", async () => {
    const gateway = new SaveCountingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    await gateway.watchStarted;
    expect(gateway.listCalls).toBe(1);
    await user.type(body, "\nA local update.");
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument(), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(gateway.listCalls).toBe(1);
  });

  it("refreshes an open note when it changes through the connector", async () => {
    const gateway = new RemoteChangeGateway();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    await gateway.watchStarted;
    await gateway.modifyRemotely();

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Changed on another device"));
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("The remote version is current.\n");
  });

  it("preserves local edits when a remote change arrives", async () => {
    const gateway = new RemoteChangeGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    await gateway.watchStarted;
    await user.type(body, "\nA local sentence.");
    await gateway.modifyRemotely();

    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect((body as HTMLTextAreaElement).value).toContain("A local sentence.");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    await user.click(screen.getByText("Review differences"));
    const diff = screen.getByRole("table", { name: "Body differences" });
    expect(within(diff).getByText(/A local sentence/)).toBeInTheDocument();
    expect(within(diff).getByText("The remote version is current.")).toBeInTheDocument();
    expect(screen.getByText("Changed on another device")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(gateway.updateCalls).toBe(0);

    await user.click(screen.getByRole("button", { name: "Keep my edits" }));
    await waitFor(() => expect(gateway.updateCalls).toBe(1));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect((body as HTMLTextAreaElement).value).toContain("A local sentence.");
  });

  it("creates a note and exposes collection-wide navigation", async () => {
    const gateway = new DemoCollectionGateway(4);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    await user.type(title, "A useful note");
    expect(screen.getByLabelText("Suggested path")).toHaveTextContent("A useful note.md");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "note");
    expect(screen.getByLabelText("Suggested path")).toHaveTextContent("Notes/A useful note.md");
    await user.type(screen.getByRole("textbox", { name: "Note body" }), "The opening paragraph is already here.");
    await user.click(screen.getByRole("button", { name: "Create note" }));
    expect(await screen.findByDisplayValue("A useful note")).toBeInTheDocument();
    await waitFor(async () => expect((await gateway.list()).notes.length).toBe(5));
    const created = await gateway.read("Notes/A useful note.md");
    expect(created.frontmatter.title).toBe("A useful note");
    expect(created.body).toBe("The opening paragraph is already here.");
  });

  it("creates untyped notes at the collection root", async () => {
    const gateway = new DemoCollectionGateway(2);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Root note");
    expect(screen.getByLabelText("Suggested path")).toHaveTextContent("Root note.md");
    await user.type(screen.getByRole("textbox", { name: "Note body" }), "Captured before creation.");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByDisplayValue("Root note")).toBeInTheDocument();
    const created = await gateway.read("Root note.md");
    expect(created.types).toEqual([]);
    expect(created.body).toBe("# Root note\n\nCaptured before creation.");
  });

  it("creates a new folder with its first note", async () => {
    const gateway = new DemoCollectionGateway(2);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const folderNavigation = screen.getByRole("group", { name: "Folders" });
    await user.click(within(folderNavigation).getByRole("button", { name: "New folder" }));

    await user.type(screen.getByRole("textbox", { name: "Folder name" }), "Research");
    await user.type(screen.getByRole("textbox", { name: "First note" }), "Reading list");
    expect(screen.getByText("Research/Reading list.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create folder" }));

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Reading list");
    expect(await gateway.read("Research/Reading list.md")).toBeDefined();
    expect(within(folderNavigation).getByRole("button", { name: /^Show notes in Research,/ })).toBeInTheDocument();
  });

  it("reveals nested folders on demand and remembers their disclosure state", async () => {
    const gateway = new DemoCollectionGateway(2);
    await gateway.create({
      title: "Nested plan",
      body: "",
      path: "Projects/Alpha/Nested plan.md",
      properties: {}
    });
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const folders = screen.getByRole("group", { name: "Folders" });
    await waitFor(() => expect(folders).toHaveAttribute("aria-busy", "false"));
    expect(within(folders).queryByRole("button", { name: /^Show notes in Projects\/Alpha,/ })).not.toBeInTheDocument();
    const disclosure = within(folders).getByRole("button", { name: "Expand Projects" });
    await user.click(disclosure);

    const nestedFolder = within(folders).getByRole("button", { name: /^Show notes in Projects\/Alpha,/ });
    await user.click(nestedFolder);
    expect(screen.getByRole("heading", { name: "Projects/Alpha" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("mdbase-editor:expanded-folders:00000000-0000-4000-8000-000000000001") ?? "[]")).toContain("Projects");
  });

  it("creates a nested folder from a folder context menu", async () => {
    const gateway = new DemoCollectionGateway(4);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const folders = screen.getByRole("group", { name: "Folders" });
    fireEvent.contextMenu(await within(folders).findByRole("button", { name: /^Show notes in Projects,/ }), {
      clientX: 60,
      clientY: 120
    });
    const menu = await screen.findByRole("menu", { name: "Projects folder actions" });
    expect(within(menu).getByRole("menuitem", { name: "New note here" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "New subfolder" }));

    await user.type(await screen.findByRole("textbox", { name: "Folder name" }), "Roadmap");
    await user.type(screen.getByRole("textbox", { name: "First note" }), "Index");
    expect(screen.getByText("Projects/Roadmap/Index.md")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create folder" }));
    expect(await gateway.read("Projects/Roadmap/Index.md")).toBeDefined();
  });

  it("seeds new notes from tag and type context menus", async () => {
    const gateway = new DemoCollectionGateway(12);
    const user = userEvent.setup();
    const firstRender = render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const tags = screen.getByRole("group", { name: "Tags" });
    await waitFor(() => expect(tags).toHaveAttribute("aria-busy", "false"));
    await user.click(within(tags).getByRole("button", { name: "Tags" }));
    fireEvent.contextMenu(within(tags).getByRole("button", { name: /^Show notes tagged #ideas,/ }), {
      clientX: 60,
      clientY: 160
    });
    await user.click(within(await screen.findByRole("menu", { name: "#ideas tag actions" }))
      .getByRole("menuitem", { name: "New note with tag" }));
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Tagged from menu");
    await user.click(screen.getByRole("button", { name: "Create note" }));
    expect((await gateway.read("Tagged from menu.md")).frontmatter.tags).toEqual(["ideas"]);

    firstRender.unmount();
    render(<App gateway={gateway} />);
    await screen.findByRole("heading", { name: "Writing" });
    const types = screen.getByRole("group", { name: "Types" });
    await waitFor(() => expect(types).toHaveAttribute("aria-busy", "false"));
    await user.click(within(types).getByRole("button", { name: "Types" }));
    const typeRow = within(types).getByRole("button", { name: /^Show notes with type note,/ });
    typeRow.focus();
    fireEvent.keyDown(typeRow, { key: "F10", shiftKey: true });
    await user.click(within(await screen.findByRole("menu", { name: "note type actions" }))
      .getByRole("menuitem", { name: "New note of type" }));
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue("note");
    expect(screen.getByLabelText("Suggested path")).toHaveTextContent("Notes/Untitled.md");
  });

  it("collapses collection facets, filters notes, and follows backlinks", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(12)} />);

    await screen.findByRole("heading", { name: "Writing" });
    const folders = screen.getByRole("group", { name: "Folders" });
    const foldersToggle = await within(folders).findByRole("button", { name: "Folders" });
    expect(foldersToggle).toHaveAttribute("aria-expanded", "true");
    await user.click(foldersToggle);
    expect(foldersToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(folders).queryByRole("button", { name: /Archive/ })).not.toBeInTheDocument();
    await user.click(foldersToggle);
    await user.click(within(folders).getByRole("button", { name: /^Show notes in Archive,/ }));
    expect(screen.getByRole("heading", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    const tags = screen.getByRole("group", { name: "Tags" });
    await user.click(within(tags).getByRole("button", { name: "Tags" }));
    await user.click(within(tags).getByRole("button", { name: /^Show notes tagged #ideas,/ }));
    expect(screen.getByRole("heading", { name: "#ideas" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);

    const types = screen.getByRole("group", { name: "Types" });
    await user.click(within(types).getByRole("button", { name: "Types" }));
    await user.click(within(types).getByRole("button", { name: /^Show notes with type note,/ }));
    expect(screen.getByRole("heading", { name: "note" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    const collection = screen.getByRole("complementary", { name: "Collection navigation" });
    await user.click(within(collection).getByRole("button", { name: /^Notes, / }));
    await user.click(screen.getByText("The shape of useful tools", { selector: ".note-title" }));
    await user.click(screen.getByRole("button", { name: "Backlinks" }));
    const backlinks = screen.getByRole("complementary", { name: "Backlinks" });
    expect(within(backlinks).getByText("1 note link here")).toBeInTheDocument();
    await user.click(within(backlinks).getByRole("button", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(screen.getByRole("complementary", { name: "Backlinks" })).toBeInTheDocument();
  });

  it("sorts the note list, preserves relevance during search, and clears the active scope", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(4)} />);

    await screen.findByRole("heading", { name: "Writing" });
    await screen.findByText("4 notes · modified newest");
    const noteList = screen.getByRole("listbox", { name: "Collection notes" });
    await within(noteList).findByText("The shape of useful tools", { selector: ".note-title" });
    expect(within(noteList).getAllByRole("option")[0]).toHaveAccessibleName(/The shape of useful tools/);

    await user.click(screen.getByRole("button", { name: "View options" }));
    let menu = screen.getByRole("menu", { name: "Note view options" });
    expect(within(menu).getByRole("menuitemradio", { name: "Modified newest" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getByRole("menuitemradio", { name: "Title A–Z" }));

    expect(within(noteList).getAllByRole("option")[0]).toHaveAccessibleName(/A quiet interface 3/);
    expect(localStorage.getItem("mdbase-editor:note-sort")).toBe("title-asc");
    expect(screen.getByText("4 notes · title A–Z")).toBeInTheDocument();

    const search = screen.getByRole("textbox", { name: "Search every note" });
    await user.type(search, "quiet interface");
    expect(await screen.findByText("1 note · relevance")).toBeInTheDocument();
    await user.clear(search);

    const folders = screen.getByRole("group", { name: "Folders" });
    await user.click(within(folders).getByRole("button", { name: /^Show notes in Notes,/ }));
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View options" }));
    menu = screen.getByRole("menu", { name: "Note view options" });
    expect(within(menu).getByRole("menuitemradio", { name: "Folder · Notes" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(menu).getByRole("menuitemradio", { name: "All notes" }));

    expect(screen.getByRole("heading", { name: "Writing" })).toBeInTheDocument();
    expect(within(noteList).getAllByRole("option")).toHaveLength(4);
    expect(within(noteList).getAllByRole("option")[0]).toHaveAccessibleName(/A quiet interface 3/);
  });

  it("edits existing types and creates new ones with a compatibility warning", async () => {
    const gateway = new DemoCollectionGateway(4);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const collection = screen.getByRole("complementary", { name: "Collection navigation" });
    await user.click(within(collection).getByRole("button", { name: "Types (1)" }));

    const description = await screen.findByRole("textbox", { name: "Description" });
    expect(screen.getByText("Collection-wide change")).toBeInTheDocument();
    await user.clear(description);
    await user.type(description, "A durable general note.");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    const addedField = screen.getByDisplayValue("field").closest<HTMLElement>(".visual-field-row")!;
    await user.click(within(addedField).getByRole("checkbox", { name: "Required" }));
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("heading", { name: "Update this type?" })).toBeInTheDocument();
    expect(screen.getByText(/1 note is missing required field/)).toHaveTextContent("field");
    await user.click(screen.getByRole("button", { name: "Confirm update" }));
    await waitFor(() => expect(screen.getByText("Saved", { selector: ".type-inspector-bar small" })).toBeInTheDocument());
    expect((await gateway.readType("note")).document).toContain("A durable general note.");

    await user.click(screen.getByRole("button", { name: "YAML" }));
    expect((await screen.findByRole("textbox", { name: "note type YAML" }) as HTMLTextAreaElement).value).toContain("kind: mdbase.type");

    await user.click(screen.getByRole("button", { name: "New type" }));
    const newTypeName = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(newTypeName);
    await user.type(newTypeName, "project");
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(screen.getByRole("button", { name: "Create type" }));

    expect(await screen.findByRole("heading", { name: "project" })).toBeInTheDocument();
    expect((await gateway.describe()).types.map((type) => type.name)).toContain("project");
  }, 15_000);

  it("keeps the note frame stable while a note is loading", async () => {
    const gateway = new SlowReadGateway();
    render(<App gateway={gateway} />);

    const loading = await screen.findByLabelText("Loading note");
    expect(loading).toHaveAttribute("aria-busy", "true");
    gateway.releaseRead();
    expect(await screen.findByRole(
      "textbox",
      { name: "Note title" },
      { timeout: 5_000 }
    )).toHaveValue("The shape of useful tools");
    expect(screen.queryByLabelText("Loading note")).not.toBeInTheDocument();
  });

  it("shows the collection-shaped opening state while metadata is loading", async () => {
    const gateway = new SlowDescriptionGateway();
    render(<App gateway={gateway} />);

    const opening = await screen.findByLabelText("Opening collection");
    expect(opening).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Reading its notes and types")).toBeInTheDocument();
    gateway.releaseDescription();
    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
  });

  it("opens the first note after the first page while the remaining index loads", async () => {
    const gateway = new ProgressiveListGateway(12);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect(screen.getByText("1 of 12 notes")).toBeInTheDocument();
    const folderNavigation = screen.getByRole("group", { name: "Folders" });
    expect(folderNavigation).toHaveAttribute("aria-busy", "true");
    expect(within(folderNavigation).getByRole("status")).toHaveTextContent("Loading");
    expect(within(folderNavigation).getByLabelText("1 or more notes in Notes")).toHaveTextContent("1+");
    expect(gateway.listCalls).toBe(1);

    gateway.releaseStructure();
    expect(await screen.findByText("12 notes · modified newest")).toBeInTheDocument();
    expect(folderNavigation).toHaveAttribute("aria-busy", "false");
    expect(within(folderNavigation).queryByRole("status")).not.toBeInTheDocument();
    expect(within(folderNavigation).getByLabelText("3 notes in Notes")).toHaveTextContent("3");

    await user.type(screen.getByRole("textbox", { name: "Search every note" }), "Record 3 remains");
    expect(await screen.findByText("Searching")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /A quiet interface 3/ })).not.toBeInTheDocument();
    gateway.releaseContent();
    expect(await screen.findByRole("option", { name: /A quiet interface 3/ })).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search every note" }));
    expect(await screen.findByText("12 notes · modified newest")).toBeInTheDocument();
    expect(gateway.listCalls).toBe(1);
  });

  it("hydrates full text in the background and reports search progress", async () => {
    const gateway = new DemandContentGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByText("3 notes · modified newest")).toBeInTheDocument();
    await waitFor(() => expect(gateway.hydrateCalls).toBe(1));
    await user.type(screen.getByRole("textbox", { name: "Search every note" }), "Record 3 remains");

    expect(await screen.findByText(/searching 1 of 3/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /A quiet interface 3/ })).not.toBeInTheDocument();
    gateway.releaseContent();

    expect(await screen.findByRole("option", { name: /A quiet interface 3/ })).toBeInTheDocument();
    expect(screen.getByText("1 note · relevance")).toBeInTheDocument();
  });

  it("keeps a failed full-text search actionable and retries it", async () => {
    const gateway = new RetryingContentGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByText("3 notes · modified newest");
    await user.type(screen.getByRole("textbox", { name: "Search every note" }), "Record 3 remains");
    const retry = await screen.findByRole("button", { name: "Retry search" });
    expect(retry).toHaveAttribute("title", "The full-text index could not be read.");
    await user.click(retry);

    expect(await screen.findByRole("option", { name: /A quiet interface 3/ })).toBeInTheDocument();
    expect(gateway.hydrateCalls).toBe(2);
  });

  it("uses the create response without re-listing or re-reading the new note", async () => {
    const gateway = new CountingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await screen.findByRole("textbox", { name: "Note title" });
    const listCalls = gateway.listCalls;
    const readCalls = gateway.readCalls;
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Fast note");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByDisplayValue("Fast note")).toBeInTheDocument();
    expect(gateway.createCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.listCalls).toBe(listCalls);
    expect(gateway.readCalls).toBe(readCalls);

    await user.click(screen.getByRole("button", { name: "Fast note.md" }));
    const path = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(path);
    await user.type(path, "Adversarial/Fast note.md{Enter}");
    expect(await screen.findByRole("button", { name: "Adversarial/Fast note.md" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.listCalls).toBe(listCalls);

    await user.click(screen.getByLabelText("More note actions"));
    await user.click(screen.getByRole("menuitem", { name: "Delete note" }));
    await user.click(await screen.findByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(gateway.deleteCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.listCalls).toBe(listCalls);
  });

  it("searches note content in the loaded index without another query or watcher", async () => {
    const gateway = new CountingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const listCalls = gateway.listCalls;
    await user.type(screen.getByRole("textbox", { name: "Search every note" }), "Record 3 remains");

    expect(await screen.findByRole("option", { name: /A quiet interface 3/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Garden notes 2/ })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.listCalls).toBe(listCalls);
    expect(gateway.watchCalls).toBe(1);
  });

  it("fuzzy-searches titles and paths and quick-opens recent notes", async () => {
    const gateway = new DemoCollectionGateway(12);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const search = await screen.findByRole("textbox", { name: "Search every note" });
    await user.type(search, "shp usfl");
    expect((await screen.findAllByRole("option", { name: /The shape of useful tools/ })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: /Garden notes 2/ })).not.toBeInTheDocument();
    await user.clear(search);
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));

    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const quickOpen = await screen.findByRole("dialog", { name: "Quick open" });
    expect(within(quickOpen).getByText("Recent notes")).toBeInTheDocument();
    const finder = within(quickOpen).getByRole("combobox", { name: "Find a note" });
    await user.type(finder, "qstn kpng");
    expect(within(quickOpen).getByRole("option", { name: /Questions worth keeping 7/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Questions worth keeping 7");
  });

  it("navigates notes and reveals keyboard help without leaving the editor", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(4)} />);

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    fireEvent.keyDown(window, { key: "j", altKey: true });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    fireEvent.keyDown(window, { key: "k", altKey: true });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools"));

    await user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const help = screen.getByRole("dialog", { name: "Shortcuts" });
    expect(help).toHaveTextContent("Quick open");
    expect(help).toHaveTextContent("Find in note");
    expect(help).toHaveTextContent("Bold or italic");
    expect(help).toHaveTextContent("Markdown commands");
    expect(help).toHaveTextContent("Next or previous note");
    await user.click(within(help).getByRole("button", { name: "Close keyboard shortcuts" }));
    expect(screen.queryByRole("dialog", { name: "Shortcuts" })).not.toBeInTheDocument();
  });

  it("opens other notes while the current note saves in the background", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    gateway.readPaths.length = 0;
    await user.type(body, "\nPending change.");
    await gateway.updateStarted;

    const first = screen.getByRole("option", { name: /The shape of useful tools/ });
    const second = screen.getByRole("option", { name: /Garden notes 2/ });
    await user.click(second);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(first).toHaveAttribute("aria-busy", "true");
    expect(first).toHaveTextContent("Saving");

    const third = screen.getByRole("option", { name: /A quiet interface 3/ });
    await user.click(third);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3"));

    gateway.releaseUpdate();
    await waitFor(() => expect(first).not.toHaveAttribute("aria-busy"));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3");
    expect(gateway.readPaths).toContain("Journal/garden-notes-2.md");
    expect(gateway.readPaths.at(-1)).toBe("Projects/a-quiet-interface-3.md");
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).toContain("Pending change.");
  });

  it("saves a second note while the first note is still saving", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nFirst note change.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    await user.type(screen.getByRole("textbox", { name: "Note body" }), "\nSecond note change.");

    await waitFor(async () => {
      expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Second note change.");
    }, { timeout: 2_000 });
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).not.toContain("First note change.");

    gateway.releaseUpdate();
    await waitFor(async () => {
      expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).toContain("First note change.");
    });
  });

  it("reopens the cached draft while its background save is still running", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.type(body, "\nStill here.");
    await gateway.updateStarted;
    const readsBeforeNavigation = gateway.readPaths.length;
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    await user.click(screen.getByRole("option", { name: /The shape of useful tools/ }));

    expect((screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement).value).toContain("Still here.");
    expect(gateway.readPaths.length).toBe(readsBeforeNavigation + 1);
    gateway.releaseUpdate();
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    expect((screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement).value).toContain("Still here.");
  });

  it("keeps a background save failure attached to its note", async () => {
    const gateway = new FailingUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nUnsaved sentence.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    gateway.failUpdate();

    expect(await screen.findByText(/Couldn’t save “The shape of useful tools”/)).toBeInTheDocument();
    const failed = screen.getByRole("option", { name: /The shape of useful tools.*Save failed/ });
    await user.click(failed);
    expect((screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement).value).toContain("Unsaved sentence.");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("orders property updates behind a note save without blocking navigation", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nBefore properties.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    await user.click(await screen.findByRole("button", { name: "Add property" }));
    await user.click(screen.getByRole("button", { name: "Add a custom property…" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "status");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "status value" }), "draft");
    expect(screen.getByText("Changes save automatically")).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(gateway.events).not.toContain("properties");
    gateway.releaseUpdate();

    await waitFor(() => expect(gateway.events).toContain("properties"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("properties"));
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).frontmatter.status).toBe("draft");
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  });

  it("orders rename preflight and mutation behind an active note save", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nBefore rename.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "Notes/the-shape-of-useful-tools.md" }));
    const path = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(path);
    await user.type(path, "Notes/renamed-in-background.md{Enter}");
    expect(gateway.events).not.toContain("preflight:rename");
    gateway.releaseUpdate();
    await user.click(await screen.findByRole("button", { name: "Rename and update links" }));
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    await waitFor(() => expect(gateway.events).toContain("rename"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("preflight:rename"));
    expect(gateway.events.indexOf("preflight:rename")).toBeLessThan(gateway.events.indexOf("rename"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("rename"));
    expect((await gateway.list()).notes.some((note) => note.path === "Notes/renamed-in-background.md")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  });

  it("shows long-running link updates beside the open note", async () => {
    const gateway = new SlowRenameGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.click(await screen.findByRole("button", { name: "Notes/the-shape-of-useful-tools.md" }));
    const path = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(path);
    await user.type(path, "Notes/renamed-with-links.md{Enter}");
    await user.click(await screen.findByRole("button", { name: "Rename and update links" }));
    await gateway.renameStarted;

    expect(screen.getAllByText("Updating 1 linked note", { exact: true })).toHaveLength(2);
    gateway.releaseRename();
    await waitFor(() => expect(screen.getByText("Saved", { exact: true })).toBeInTheDocument());
  });

  it("cancels a resumable rename without losing its recovery action", async () => {
    const gateway = new CancellableRenameGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.click(await screen.findByRole("button", { name: "Notes/the-shape-of-useful-tools.md" }));
    const path = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(path);
    await user.type(path, "Notes/resumable-rename.md{Enter}");
    await user.click(await screen.findByRole("button", { name: "Rename and update links" }));
    await gateway.renameStarted;

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText(/authoritative result/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Markdown path" })).toHaveValue("Notes/resumable-rename.md");

    await user.click(screen.getByRole("button", { name: "Resume rename" }));
    await waitFor(() => expect(gateway.renameCalls).toBe(2));
    expect(await screen.findByRole("button", { name: "Notes/resumable-rename.md" })).toBeInTheDocument();
  });

  it("preflights linked renames and can undo a rename-only move", async () => {
    const gateway = new DemoCollectionGateway(3);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.click(await screen.findByRole("button", { name: "Notes/the-shape-of-useful-tools.md" }));
    const path = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(path);
    await user.type(path, "Archive/useful-tools.md{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("1 note contains links that will change");
    await user.click(screen.getByRole("button", { name: "Rename only" }));
    expect(await screen.findByRole("button", { name: "Archive/useful-tools.md" })).toBeInTheDocument();
    expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Notes/the-shape-of-useful-tools");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Notes/the-shape-of-useful-tools.md" })).toBeInTheDocument();
    expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Notes/the-shape-of-useful-tools");
  });

  it("orders validation behind a note save without blocking navigation", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nBefore validation.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Check note" }));
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(gateway.events).not.toContain("validate");
    gateway.releaseUpdate();
    await waitFor(() => expect(gateway.events).toContain("validate"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("validate"));
    expect(screen.queryByText("No validation issues.")).not.toBeInTheDocument();
  });

  it("preflights and deletes a note after its active save", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nDiscard with note.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete note" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(gateway.events).not.toContain("preflight:delete");
    gateway.releaseUpdate();
    const confirmation = await screen.findByRole("alert");
    expect(confirmation).toHaveTextContent("1 note will keep a broken link");
    await user.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    await waitFor(() => expect(gateway.events).toContain("delete"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("preflight:delete"));
    expect(gateway.events.indexOf("preflight:delete")).toBeLessThan(gateway.events.indexOf("delete"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("delete"));
    await waitFor(() => expect(screen.queryByRole("option", { name: /The shape of useful tools/ })).not.toBeInTheDocument());
    expect((await gateway.list()).notes.some((note) => note.path === "Notes/the-shape-of-useful-tools.md")).toBe(false);
  });

  it("restores a deleted note without reloading the collection", async () => {
    const gateway = new CountingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("textbox", { name: "Note title" });
    const listCalls = gateway.listCalls;
    await user.click(screen.getByLabelText("More note actions"));
    await user.click(screen.getByRole("menuitem", { name: "Delete note" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("option", { name: /The shape of useful tools/ })).toBeInTheDocument();
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).toContain("Good tools leave room");
    expect(gateway.listCalls).toBe(listCalls);
  });

  it("renders an explicit full-access explanation before authorization", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    disconnected.sessionSnapshot = () => ({ status: "unselected", connections: [] });
    render(<App gateway={disconnected} />);
    expect(await screen.findByRole("button", { name: "Choose a collection" })).toBeInTheDocument();
    expect(screen.getByText(/collection you want to write in/i)).toBeInTheDocument();
    expect(await screen.findByText(/continue to mdbase connect/i)).toBeInTheDocument();
    expect(screen.getByText(/return here automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/your files stay where they are/i)).toBeInTheDocument();
    await userEvent.click(screen.getByText("Collection not listed?"));
    expect(screen.getByText(/upgrade a copy, verify that copy/i)).toBeInTheDocument();
    expect(screen.getByText(/original files can stay untouched/i)).toBeInTheDocument();
  });

  it("completes an authorization callback before reading the remembered connection", async () => {
    const gateway = new DemoCollectionGateway(1);
    const callbackGateway = Object.create(gateway) as CollectionGateway;
    const events: string[] = [];
    callbackGateway.startSession = vi.fn(async () => {
      events.push("complete");
      return gateway.sessionSnapshot();
    });
    callbackGateway.sessionSnapshot = vi.fn(() => {
      events.push("snapshot");
      return gateway.sessionSnapshot();
    });
    callbackGateway.onSessionChange = vi.fn(() => () => undefined);
    callbackGateway.describe = vi.fn(async () => {
      events.push("describe");
      return gateway.describe();
    });

    render(<App gateway={callbackGateway} />);

    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
    expect(events.indexOf("complete")).toBeLessThan(events.indexOf("describe"));
  });

  it("forgets one saved connection from the connection screen without implying deletion or revocation", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    let connections: ConnectionSummary[] = [
      { collectionId: "current-notes", displayName: "Notes", operations: [] },
      { collectionId: "old-notes", displayName: "Old Notes", operations: [] }
    ];
    const snapshot = (): CollectionSessionSnapshot => ({ status: "unselected", connections });
    let publish: ((value: CollectionSessionSnapshot) => void) | undefined;
    const forgetConnection = vi.fn((collectionId: string) => {
      connections = connections.filter((connection) => connection.collectionId !== collectionId);
      publish?.(snapshot());
    });
    disconnected.sessionSnapshot = snapshot;
    disconnected.onSessionChange = (listener) => {
      publish = listener;
      listener(snapshot());
      return () => {
        publish = undefined;
      };
    };
    disconnected.forgetConnection = forgetConnection;
    render(<App gateway={disconnected} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Collection options for Old Notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Forget from this browser" }));

    const confirmation = screen.getByRole("alertdialog", { name: "Forget “Old Notes” from this browser?" });
    expect(confirmation).toHaveTextContent("does not delete the collection or its files");
    expect(confirmation).toHaveTextContent("does not revoke mdbase editor’s access");
    await user.click(within(confirmation).getByRole("button", { name: "Forget from this browser" }));

    expect(forgetConnection).toHaveBeenCalledWith("old-notes");
    await waitFor(() => expect(screen.queryByText("Old Notes")).not.toBeInTheDocument());
    expect(screen.getByText("Notes")).toBeInTheDocument();
  });

  it("starts a new authorization when choosing another collection from the connection screen", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    const authorize = vi.fn(async () => undefined);
    disconnected.authorize = authorize;
    disconnected.sessionSnapshot = () => ({
      status: "unselected",
      connections: [{ collectionId: "demo", operations: [] }]
    });
    disconnected.describe = vi.fn(async () => {
      throw new Error("The current collection could not be opened.");
    });
    render(<App gateway={disconnected} />);

    await userEvent.click(await screen.findByRole("button", { name: "Choose another collection" }));

    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith("choose");
  });

  it("authorizes the requested collection from a portal deep link", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    const authorize = vi.fn(async () => undefined);
    disconnected.authorize = authorize;
    disconnected.sessionSnapshot = () => ({
      status: "unavailable",
      collectionId: "deep-linked-collection",
      reason: "not_authorized",
      connections: [{ collectionId: "demo", operations: [] }]
    });
    disconnected.describe = vi.fn(async () => {
      throw new Error("The requested collection has not been authorized.");
    });
    render(<App gateway={disconnected} />);

    await userEvent.click(await screen.findByRole("button", { name: "Choose another collection" }));

    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith("selected");
  });

  it("returns to collection authorization when the SDK invalidates a stale grant", async () => {
    const gateway = new RevokedAuthorizationGateway();
    render(<App gateway={gateway} />);
    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();

    act(() => gateway.rejectAuthorization());

    expect(await screen.findByRole("button", { name: "Choose a collection" })).toBeInTheDocument();
  });

  it("explains and requests only capabilities missing from an existing connection", async () => {
    const gateway = new DemoCollectionGateway(1);
    const partial = Object.create(gateway) as CollectionGateway;
    const authorize = vi.fn(async () => undefined);
    const connection = {
      collectionId: "partial",
      operations: ["describe", "read", "query"],
      missingCapabilities: ["records.update", "records.rename", "definitions.read"]
    };
    partial.sessionSnapshot = () => ({ status: "ready", connection, connections: [connection] });
    partial.authorize = authorize;
    render(<App gateway={partial} />);

    expect(await screen.findByRole("button", { name: "Update access" })).toBeInTheDocument();
    expect(screen.getByText(/edit notes and move notes/i)).toBeInTheDocument();
    expect(screen.getByText(/shows only what needs to be added/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update access" }));
    expect(authorize).toHaveBeenCalledWith("selected");
  });

  it("keeps note editing available when only optional type access is missing", async () => {
    const gateway = new DemoCollectionGateway(1);
    const partial = Object.create(gateway) as CollectionGateway;
    const authorize = vi.fn(async () => undefined);
    const connection = {
      collectionId: "notes-only",
      operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"],
      missingCapabilities: ["definitions.read", "definitions.create", "definitions.update"]
    };
    partial.sessionSnapshot = () => ({ status: "ready", connection, connections: [connection] });
    partial.authorize = authorize;
    render(<App gateway={partial} />);

    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Note body" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Types (1)" }));
    expect(await screen.findByRole("heading", { name: "Type access needed" })).toBeInTheDocument();
    expect(screen.getByText(/Notes are ready/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Update access" }));
    expect(authorize).toHaveBeenCalledWith("selected");
  });

  it("shows a dropped connection and offers an immediate retry", async () => {
    const gateway = new ReconnectingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const reconnecting = await screen.findByRole("status", { name: "Collection reconnecting" });
    expect(reconnecting).toHaveAttribute("title", "The test connection dropped.");
    await user.click(screen.getByRole("button", { name: "Retry connection" }));

    expect(await screen.findByRole("status", { name: "Collection connected" }, { timeout: 2_000 })).toBeInTheDocument();
    expect(gateway.watchCalls).toBeGreaterThanOrEqual(2);
  });

  it("refreshes collection state before recovering from an expired change cursor", async () => {
    const gateway = new ResettingCursorGateway();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("status", { name: "Collection connected" })).toBeInTheDocument();
    await waitFor(() => expect(gateway.listCalls).toBe(2));
    await waitFor(() => expect(gateway.watchCalls).toBe(2));
  });

  it("keeps an index failure visible and lets the user retry it", async () => {
    const gateway = new RetryingListGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The note index could not be read.");
    expect(gateway.hydrateCalls).toBe(0);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Note title" })).toBeInTheDocument();
    expect(gateway.listCalls).toBe(2);
  });
});

class RevokedAuthorizationGateway extends DemoCollectionGateway {
  private connected = true;

  override sessionSnapshot(): CollectionSessionSnapshot {
    if (this.connected) return super.sessionSnapshot();
    return {
      status: "unavailable",
      collectionId: "demo",
      reason: "authorization_lost",
      connections: []
    };
  }

  rejectAuthorization(): void {
    this.connected = false;
    this.emitSessionChange();
  }
}

class DirectAccessGateway extends DemoCollectionGateway {
  private directAccess: DirectAccessStatus = "permission_required";
  checkCalls = 0;
  requestCalls = 0;

  protected override currentConnection(): ConnectionSummary | null {
    const connection = super.currentConnection();
    return connection ? {
      ...connection,
      authorityKind: "connector",
      directAccess: this.directAccess
    } : null;
  }

  override async checkDirectAccess(): Promise<ConnectionSummary | null> {
    this.checkCalls += 1;
    return this.currentConnection();
  }

  override async requestDirectAccess(): Promise<ConnectionSummary | null> {
    this.requestCalls += 1;
    this.directAccess = "available";
    this.emitSessionChange();
    return this.currentConnection();
  }
}

class RetryingListGateway extends DemoCollectionGateway {
  listCalls = 0;
  hydrateCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    this.listCalls += 1;
    if (this.listCalls === 1) throw new Error("The note index could not be read.");
    return super.list(options);
  }

  override async hydrateContent(options: NoteContentRequest = {}): Promise<NoteIndexResult> {
    this.hydrateCalls += 1;
    return super.hydrateContent(options);
  }
}

class DemandContentGateway extends DemoCollectionGateway {
  private fullNotes: NoteSummary[] = [];
  private release?: () => void;
  hydrateCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    const result = await super.list();
    this.fullNotes = (await super.hydrateContent({ snapshot: result.snapshot })).notes;
    const structure = this.fullNotes.map(({ body: _body, ...note }) => note);
    options.onProgress?.({ notes: structure, snapshot: result.snapshot, structureComplete: true, complete: true, contentComplete: false, contentLoaded: 0, total: structure.length });
    return { notes: structure, snapshot: result.snapshot };
  }

  override async hydrateContent(options: NoteContentRequest = {}): Promise<NoteIndexResult> {
    this.hydrateCalls += 1;
    options.onProgress?.({ notes: this.fullNotes.slice(0, 1), snapshot: options.snapshot, structureComplete: true, complete: false, contentComplete: false, contentLoaded: 1, total: this.fullNotes.length });
    await new Promise<void>((resolve) => { this.release = resolve; });
    options.signal?.throwIfAborted();
    options.onProgress?.({ notes: this.fullNotes, snapshot: options.snapshot, structureComplete: true, complete: true, contentComplete: true, contentLoaded: this.fullNotes.length, total: this.fullNotes.length });
    return { notes: this.fullNotes, snapshot: options.snapshot };
  }

  releaseContent() {
    this.release?.();
  }
}

class RetryingContentGateway extends DemoCollectionGateway {
  private fullNotes: NoteSummary[] = [];
  hydrateCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    const result = await super.list();
    this.fullNotes = (await super.hydrateContent({ snapshot: result.snapshot })).notes;
    const structure = this.fullNotes.map(({ body: _body, ...note }) => note);
    options.onProgress?.({ notes: structure, snapshot: result.snapshot, structureComplete: true, complete: true, contentComplete: false, contentLoaded: 0, total: structure.length });
    return { notes: structure, snapshot: result.snapshot };
  }

  override async hydrateContent(options: NoteContentRequest = {}): Promise<NoteIndexResult> {
    this.hydrateCalls += 1;
    if (this.hydrateCalls === 1) throw new Error("The full-text index could not be read.");
    options.onProgress?.({ notes: this.fullNotes, snapshot: options.snapshot, structureComplete: true, complete: true, contentComplete: true, contentLoaded: this.fullNotes.length, total: this.fullNotes.length });
    return { notes: this.fullNotes, snapshot: options.snapshot };
  }
}

class ReconnectingGateway extends DemoCollectionGateway {
  watchCalls = 0;

  constructor() {
    super(3);
  }

  override async watch(_onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void): Promise<void> {
    this.watchCalls += 1;
    onStatus?.({ state: "connecting" });
    if (this.watchCalls === 1) {
      onStatus?.({ state: "reconnecting", cursor: 1, attempt: 1, retryInMs: 500, problem: connectProblem("temporarily_unavailable", "The test connection dropped.") });
    } else {
      onStatus?.({ state: "connected", cursor: 1, recovered: false });
    }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

class ResettingCursorGateway extends DemoCollectionGateway {
  listCalls = 0;
  watchCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    this.listCalls += 1;
    return super.list(options);
  }

  override async watch(_onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: WatchStatus) => void): Promise<void> {
    this.watchCalls += 1;
    onStatus?.({ state: "connecting" });
    if (this.watchCalls === 1) {
      const problem = connectProblem("change_cursor_reset", "Refresh collection state.");
      const error = new ConnectOutcomeError(problem);
      onStatus?.({ state: "reset_required", cursor: 1, problem });
      throw error;
    }
    onStatus?.({ state: "connected", cursor: 2, recovered: false });
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

class RemoteChangeGateway extends DemoCollectionGateway {
  private remote?: NoteDocument;
  private listener?: (change?: CollectionChange) => void;
  private markWatching?: () => void;
  readonly watchStarted = new Promise<void>((resolve) => { this.markWatching = resolve; });
  updateCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    if (!this.remote) return super.list(options);
    const result = await super.list();
    const notes = result.notes;
    const { revision: _revision, ...summary } = this.remote;
    const updated = notes.map((note) => note.path === summary.path
      ? structuredClone({
          ...summary,
          file: { ...summary.file, path: summary.path }
        })
      : note);
    options.onProgress?.({ notes: updated, snapshot: result.snapshot, structureComplete: true, complete: true, total: updated.length });
    return { notes: updated, snapshot: result.snapshot };
  }

  override async read(path: string): Promise<NoteDocument> {
    if (this.remote?.path === path) return structuredClone(this.remote);
    return super.read(path);
  }

  override async update(input: Parameters<DemoCollectionGateway["update"]>[0]): Promise<NoteDocument> {
    this.updateCalls += 1;
    if (!this.remote || this.remote.path !== input.path) return super.update(input);
    if (this.remote.revision !== input.revision) throw new Error("This note changed elsewhere. Reload it before saving.");
    this.remote = {
      ...this.remote,
      body: `# ${input.title}\n\n${input.body}`,
      revision: "remote-saved"
    };
    return structuredClone(this.remote);
  }

  override async watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal): Promise<void> {
    this.listener = onChange;
    this.markWatching?.();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.listener = undefined;
  }

  async modifyRemotely() {
    const current = await super.read("Notes/the-shape-of-useful-tools.md");
    this.remote = {
      ...current,
      body: "# Changed on another device\n\nThe remote version is current.\n",
      revision: "remote-2",
      file: { ...current.file, mtime: new Date().toISOString() }
    };
    this.listener?.({
      cursor: 2,
      type: "mdbase.record.modified",
      occurred_at: new Date().toISOString(),
      payload: { path: current.path, types: current.types }
    });
  }
}

class SlowReadGateway extends DemoCollectionGateway {
  private release?: () => void;

  constructor() {
    super(1);
  }

  override async read(path: string): Promise<NoteDocument> {
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.read(path);
  }

  releaseRead() {
    this.release?.();
  }
}

class SlowDescriptionGateway extends DemoCollectionGateway {
  private release?: () => void;

  constructor() {
    super(2);
  }

  override async describe() {
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.describe();
  }

  releaseDescription() {
    this.release?.();
  }
}

class ProgressiveListGateway extends DemoCollectionGateway {
  private releaseStructurePage?: () => void;
  private releaseContentPage?: () => void;
  listCalls = 0;

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    this.listCalls += 1;
    const result = await super.list();
    const notes = (await super.hydrateContent({ snapshot: result.snapshot })).notes;
    const structure = notes.map(({ body: _body, ...note }) => note);
    options.onProgress?.({ notes: structure.slice(0, 1), snapshot: result.snapshot, structureComplete: false, complete: false, total: notes.length });
    await new Promise<void>((resolve) => { this.releaseStructurePage = resolve; });
    options.signal?.throwIfAborted();
    options.onProgress?.({ notes: structure, snapshot: result.snapshot, structureComplete: true, complete: false, total: notes.length });
    await new Promise<void>((resolve) => { this.releaseContentPage = resolve; });
    options.signal?.throwIfAborted();
    options.onProgress?.({ notes, snapshot: result.snapshot, structureComplete: true, complete: true, total: notes.length });
    return { notes, snapshot: result.snapshot };
  }

  releaseStructure() {
    this.releaseStructurePage?.();
  }

  releaseContent() {
    this.releaseContentPage?.();
  }
}

class CountingGateway extends DemoCollectionGateway {
  private listener?: (change?: CollectionChange) => void;
  listCalls = 0;
  readCalls = 0;
  createCalls = 0;
  deleteCalls = 0;
  watchCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    this.listCalls += 1;
    return super.list(options);
  }

  override async read(path: string): Promise<NoteDocument> {
    this.readCalls += 1;
    return super.read(path);
  }

  override async create(input: Parameters<DemoCollectionGateway["create"]>[0]): Promise<NoteDocument> {
    this.createCalls += 1;
    const created = await super.create(input);
    this.listener?.({
      cursor: 1,
      type: "mdbase.record.created",
      occurred_at: new Date().toISOString(),
      payload: { path: created.path, types: created.types }
    });
    return created;
  }

  override async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    const renamed = await super.rename(from, to, revision, updateRefs, options);
    this.listener?.({
      cursor: 2,
      type: "mdbase.record.renamed",
      occurred_at: new Date().toISOString(),
      payload: { from, to, types: renamed.types }
    });
    return renamed;
  }

  override async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    await super.delete(path, revision, options);
    this.deleteCalls += 1;
    this.listener?.({
      cursor: 3,
      type: "mdbase.record.deleted",
      occurred_at: new Date().toISOString(),
      payload: { path, previous_types: [] }
    });
  }

  override async watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal): Promise<void> {
    this.watchCalls += 1;
    this.listener = onChange;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.listener = undefined;
  }
}

class SaveCountingGateway extends DemoCollectionGateway {
  private listener?: (change?: CollectionChange) => void;
  private markWatching?: () => void;
  readonly watchStarted = new Promise<void>((resolve) => { this.markWatching = resolve; });
  listCalls = 0;

  constructor() {
    super(3);
  }

  override async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> {
    this.listCalls += 1;
    return super.list(options);
  }

  override async update(input: Parameters<DemoCollectionGateway["update"]>[0]): Promise<NoteDocument> {
    const updated = await super.update(input);
    this.listener?.({
      cursor: 1,
      type: "mdbase.record.modified",
      occurred_at: new Date().toISOString(),
      payload: { path: updated.path, types: updated.types }
    });
    return updated;
  }

  override async watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal): Promise<void> {
    this.listener = onChange;
    this.markWatching?.();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.listener = undefined;
  }
}

class SlowUpdateGateway extends DemoCollectionGateway {
  private release?: () => void;
  private markStarted?: () => void;
  private readonly blockedUpdate = new Promise<void>((resolve) => { this.release = resolve; });
  readonly updateStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });
  readPaths: string[] = [];
  events: string[] = [];

  constructor() {
    super(3);
  }

  override async read(path: string): Promise<NoteDocument> {
    this.readPaths.push(path);
    return super.read(path);
  }

  override async update(input: Parameters<DemoCollectionGateway["update"]>[0]): Promise<NoteDocument> {
    this.events.push("save:start");
    if (input.path === "Notes/the-shape-of-useful-tools.md") {
      this.markStarted?.();
      await this.blockedUpdate;
    }
    const updated = await super.update(input);
    this.events.push("save:end");
    return updated;
  }

  override async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    this.events.push("properties");
    return super.updateDocument(path, document, revision);
  }

  override async preflightRename(from: string, to: string, revision: string) {
    this.events.push("preflight:rename");
    return super.preflightRename(from, to, revision);
  }

  override async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    this.events.push("rename");
    return super.rename(from, to, revision, updateRefs, options);
  }

  override async validate(): Promise<[]> {
    this.events.push("validate");
    return [];
  }

  override async preflightDelete(path: string, revision: string) {
    this.events.push("preflight:delete");
    return super.preflightDelete(path, revision);
  }

  override async delete(path: string, revision: string, options: MutationOperationOptions = {}): Promise<void> {
    this.events.push("delete");
    return super.delete(path, revision, options);
  }

  releaseUpdate() {
    this.release?.();
  }
}

class SlowRenameGateway extends DemoCollectionGateway {
  private release?: () => void;
  private markStarted?: () => void;
  private readonly blockedRename = new Promise<void>((resolve) => { this.release = resolve; });
  readonly renameStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });

  constructor() {
    super(3);
  }

  override async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    options.onProgress?.({
      operation: "rename",
      state: "applying",
      elapsedMs: 0,
      cancellable: false,
      resumed: false,
      completedUnits: 0,
      estimate: { affectedRecords: updateRefs ? 1 : 0, totalUnits: updateRefs ? 2 : 1, warnings: 0 }
    });
    this.markStarted?.();
    await this.blockedRename;
    return super.rename(from, to, revision, updateRefs, options);
  }

  releaseRename() {
    this.release?.();
  }
}

class CancellableRenameGateway extends DemoCollectionGateway {
  private markStarted?: () => void;
  readonly renameStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });
  renameCalls = 0;

  constructor() {
    super(3);
  }

  override async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
    this.renameCalls += 1;
    if (this.renameCalls === 1) {
      options.onProgress?.({
        operation: "rename",
        state: "applying",
        elapsedMs: 0,
        cancellable: true,
        resumed: false,
        completedUnits: 0,
        estimate: { affectedRecords: updateRefs ? 1 : 0, totalUnits: updateRefs ? 2 : 1, warnings: 0 }
      });
      this.markStarted?.();
      await new Promise<void>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new ConnectOutcomeError(connectProblem(
        "operation_outcome_unknown",
        "Waiting was cancelled after the mutation was sent. Resume the pending mutation to recover its authoritative result.",
        { operationOutcome: "unknown" }
      ))), { once: true }));
    }
    return super.rename(from, to, revision, updateRefs, options);
  }
}

class FailingUpdateGateway extends DemoCollectionGateway {
  private fail?: () => void;
  private markStarted?: () => void;
  readonly updateStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });

  constructor() {
    super(3);
  }

  override async update(): Promise<NoteDocument> {
    this.markStarted?.();
    await new Promise<void>((resolve) => { this.fail = resolve; });
    throw new Error("The relay could not save this note.");
  }

  failUpdate() {
    this.fail?.();
  }
}
