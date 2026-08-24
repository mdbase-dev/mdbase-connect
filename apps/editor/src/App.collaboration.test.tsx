import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type {
  ExperimentalHostedMarkdownRoom,
  ExperimentalHostedMarkdownRoomListener,
  ExperimentalHostedMarkdownRoomSnapshot
} from "@mdbase-dev/connect-collaboration";
import { App } from "./App";
import { editableNote } from "./note";
import { DemoCollectionGateway } from "./demo-gateway";
import type { JsonObject } from "@mdbase-dev/connect";
import type { ConnectionSummary, NoteDocument, SaveNoteInput } from "./model";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label, readOnly }: {
    value: string;
    onChange?: (value: string) => void;
    label: string;
    readOnly?: boolean;
  }) => <textarea
    aria-label={label}
    value={value}
    readOnly={readOnly}
    onChange={(event) => onChange?.(event.target.value)}
  />
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      start: index * 76,
      size: 76
    }))
  })
}));

const collaborationTests = __MDBASE_EDITOR_EXPERIMENTAL_HOSTED_COLLABORATION__
  ? describe
  : describe.skip;

collaborationTests("LAB Editor hosted collaboration", () => {
  it("binds only after synchronization and never conventionally autosaves room body", async () => {
    const gateway = new CollaborationGateway();
    const initialPath = (await gateway.list()).notes[0]!.path;
    const initial = await gateway.read(initialPath);
    await gateway.updateProperties(initialPath, { removeAfterSync: true }, initial.revision);
    gateway.propertyUpdates = 0;
    gateway.lastPropertyPatch = undefined;
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const title = await screen.findByRole("textbox", { name: "Note title" });
    const body = await screen.findByRole("textbox", { name: "Note body" });
    expect(title).toHaveAttribute("readonly");
    expect(body).toHaveAttribute("readonly");
    expect(screen.getByText("Connecting live editing")).toBeInTheDocument();

    const room = await gateway.firstRoom;
    act(() => room.emit({
      state: "connected",
      body: "# Shared heading\n\nExact collaborative body 👋\n",
      mode: "read_write",
      epoch: 9,
      pendingUpdates: 0,
      participants: []
    }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note body" }))
      .toHaveValue("# Shared heading\n\nExact collaborative body 👋\n"));
    expect(screen.getByRole("textbox", { name: "Note body" })).not.toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Shared heading");
    expect(screen.getByText("Live")).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(gateway.conventionalUpdates).toBe(0);

    act(() => room.emit({ ...room.snapshot, pendingUpdates: 1 }));
    await act(async () => room.acknowledge());
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    const jsonTab = await screen.findByRole("tab", { name: /JSON/ });
    const properties = screen.getByRole("complementary", { name: "Note properties" });
    expect(within(properties).queryByRole("tab", { name: /Source/ })).not.toBeInTheDocument();
    await user.click(jsonTab);
    fireEvent.change(within(properties).getByRole("textbox", { name: "Raw frontmatter JSON" }), {
      target: { value: JSON.stringify({ status: "shared" }, null, 2) }
    });
    await waitFor(() => expect(gateway.propertyUpdates).toBe(1));
    expect(gateway.documentUpdates).toBe(0);
    expect(Object.values(gateway.lastPropertyPatch ?? {})).toContain(null);
    expect(room.body.toString()).toBe("# Shared heading\n\nExact collaborative body 👋\n");
  });

  it("retains but does not autosave property drafts while the room reconnects", async () => {
    const gateway = new CollaborationGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);
    const room = await gateway.firstRoom;
    act(() => room.emit({
      state: "connected",
      body: "# Shared\n\nBody\n",
      mode: "read_write",
      epoch: 5,
      pendingUpdates: 0,
      participants: []
    }));
    await screen.findByText("Live");
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    const jsonTab = await screen.findByRole("tab", { name: /JSON/ });
    await user.click(jsonTab);
    const raw = screen.getByRole("textbox", { name: "Raw frontmatter JSON" });
    fireEvent.change(raw, { target: { value: JSON.stringify({ status: "offline draft" }) } });

    act(() => room.emit({ ...room.snapshot, state: "reconnecting" }));
    expect(screen.getByRole("complementary", { name: "Note properties" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Raw frontmatter JSON" })).toHaveAttribute("readonly"));
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(gateway.propertyUpdates).toBe(0);
  });

  it("keeps every body-affecting control read-only for read-only collaborators", async () => {
    const gateway = new CollaborationGateway("read_only");
    render(<App gateway={gateway} />);
    const room = await gateway.firstRoom;
    act(() => room.emit({
      state: "connected",
      body: "# Read only\n\nVisible body\n",
      mode: "read_only",
      epoch: 3,
      pendingUpdates: 0,
      participants: []
    }));

    await screen.findByText("Live · Read only");
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Note properties" })).toBeDisabled();
    expect(document.querySelector(".path-button")).toBeDisabled();
    const actions = screen.getByRole("button", { name: "More note actions" });
    actions.click();
    expect(await screen.findByRole("menuitem", { name: "Delete note" })).toBeDisabled();
  });

  it("blocks workspace surface changes until pending room updates are acknowledged", async () => {
    const gateway = new CollaborationGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);
    const room = await gateway.firstRoom;
    act(() => room.emit({
      state: "connected",
      body: "# Shared\n\nPending body\n",
      mode: "read_write",
      epoch: 6,
      pendingUpdates: 1,
      participants: []
    }));
    await screen.findByText("Saving live changes");

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("main", { name: "Note editor" })).toBeInTheDocument();
    await act(async () => room.acknowledge());
    await screen.findByRole("heading", { name: "Settings" });
  });

  it("blocks note navigation until pending room updates are acknowledged", async () => {
    const gateway = new CollaborationGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const room = await gateway.firstRoom;
    act(() => room.emit({
      state: "connected",
      body: "# Shared heading\n\nPending body\n",
      mode: "read_write",
      epoch: 4,
      pendingUpdates: 1,
      participants: []
    }));
    await screen.findByText("Saving live changes");

    const target = screen.getAllByRole("option").find((option) =>
      option.querySelector(".note-title")?.textContent === "Garden notes 2");
    expect(target).toBeDefined();
    await user.click(target!);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Shared heading");

    await act(async () => room.acknowledge());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" }))
      .toHaveValue("Garden notes 2"));
    expect(room.flush).toHaveBeenCalled();
  });
});

class CollaborationGateway extends DemoCollectionGateway {
  conventionalUpdates = 0;
  propertyUpdates = 0;
  documentUpdates = 0;
  lastPropertyPatch?: JsonObject;
  private rooms = new Map<string, FakeRoom>();
  private resolveFirstRoom!: (room: FakeRoom) => void;
  readonly firstRoom = new Promise<FakeRoom>((resolve) => {
    this.resolveFirstRoom = resolve;
  });

  constructor(private readonly access: "read_only" | "read_write" = "read_write") {
    super();
  }

  protected override currentConnection(): ConnectionSummary {
    return {
      collectionId: "demo",
      operations: ["all"],
      missingCapabilities: [],
      authorityKind: "hosted",
      collaborationAccess: this.access,
      fileActions: ["list", "read", "add", "replace", "move", "delete"]
    };
  }

  override async update(input: SaveNoteInput): Promise<NoteDocument> {
    this.conventionalUpdates += 1;
    return super.update(input);
  }

  override async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    this.propertyUpdates += 1;
    this.lastPropertyPatch = structuredClone(patch);
    return super.updateProperties(path, patch, revision);
  }

  override async updateDocument(path: string, document: string, revision: string): Promise<NoteDocument> {
    this.documentUpdates += 1;
    return super.updateDocument(path, document, revision);
  }

  override async openExperimentalCollaboration(options: { path: string }): Promise<ExperimentalHostedMarkdownRoom> {
    let room = this.rooms.get(options.path);
    if (!room) {
      room = new FakeRoom((body) => this.commitCollaborationBody(options.path, body));
      this.rooms.set(options.path, room);
      if (this.rooms.size === 1) this.resolveFirstRoom(room);
    }
    return room;
  }

  private async commitCollaborationBody(path: string, body: string): Promise<void> {
    const current = await this.read(path);
    const draft = editableNote({ ...current, body });
    await super.update({
      path,
      revision: current.revision,
      frontmatter: current.frontmatter,
      ...draft
    });
  }
}

class FakeRoom implements ExperimentalHostedMarkdownRoom {
  readonly doc = new Y.Doc();
  readonly body = this.doc.getText("body");
  readonly undoManager = new Y.UndoManager(this.body);
  private listeners = new Set<ExperimentalHostedMarkdownRoomListener>();
  private current: ExperimentalHostedMarkdownRoomSnapshot = {
    state: "connecting",
    body: "",
    pendingUpdates: 0,
    participants: []
  };
  private flushWaiters: Array<() => void> = [];

  constructor(private readonly commit: (body: string) => Promise<void> = async () => undefined) {}

  readonly subscribe = vi.fn((listener: ExperimentalHostedMarkdownRoomListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  });
  readonly setAwareness = vi.fn();
  readonly flush = vi.fn(() => {
    if (this.current.pendingUpdates === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.flushWaiters.push(resolve));
  });
  readonly close = vi.fn();
  readonly destroy = vi.fn();

  get snapshot(): ExperimentalHostedMarkdownRoomSnapshot {
    return this.current;
  }

  emit(snapshot: ExperimentalHostedMarkdownRoomSnapshot): void {
    const current = this.body.toString();
    if (current !== snapshot.body) {
      this.doc.transact(() => {
        if (this.body.length) this.body.delete(0, this.body.length);
        if (snapshot.body) this.body.insert(0, snapshot.body);
      }, "test-remote");
    }
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  async acknowledge(): Promise<void> {
    await this.commit(this.current.body);
    this.emit({ ...this.current, pendingUpdates: 0 });
    for (const resolve of this.flushWaiters.splice(0)) resolve();
  }
}
