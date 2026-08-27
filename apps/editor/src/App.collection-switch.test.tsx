import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionAuthorizationTarget, CollectionFile, CollectionSessionSnapshot, ConnectionSummary, CreateNoteInput, FileUploadRequest, NoteDocument, NoteIndexRequest, NoteIndexResult, SaveNoteInput } from "./model";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) => <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} /> }));
vi.mock("./MarkdownNoteEditor", () => ({ MarkdownNoteEditor: ({ draft, insertion, onTitleChange, onBodyChange, onCreateLink }: { draft: { title: string; body: string }; insertion?: { text: string }; onTitleChange: (value: string) => void; onBodyChange: (value: string) => void; onCreateLink: (target: string, label: string | undefined, format: "wikilink") => void }) => <>
  <input aria-label="Note title" value={draft.title} onChange={(event) => onTitleChange(event.target.value)} />
  <textarea aria-label="Note body" value={draft.body} onChange={(event) => onBodyChange(event.target.value)} />
  <button onClick={() => onCreateLink("Shared/linked.md", "Linked", "wikilink")}>Create hostile link</button>
  {insertion && <output aria-label="Editor insertion">{insertion.text}</output>}
</> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const path = "Shared/same.md";
function note(collection: "a" | "b"): NoteDocument { const title = collection === "a" ? "Alpha note" : "Bravo note", body = `# ${title}\n\n${collection === "a" ? "Alpha body" : "Bravo body"}`; return { path, revision: `${collection}-1`, body, frontmatter: {}, effectiveFrontmatter: {}, types: [], document: body, file: { name: "same.md", folder: "Shared", size: body.length, mtime: "2026-01-01T00:00:00Z", tags: [], links: [], embeds: [] } }; }
function connection(id: "a" | "b"): ConnectionSummary { return { collectionId: id, displayName: id === "a" ? "Collection A" : "Collection B", operations: ["all"], missingCapabilities: [], fileActions: ["list", "read", "add", "replace", "move", "delete"] }; }

class SwitchGateway extends DemoCollectionGateway {
  current: "a" | "b" = "a";
  documents = { a: note("a"), b: note("b") };
  authorizeGate = deferred<void>(); updateGate = deferred<void>();
  authorizeCalls = 0; describeCalls = 0; forgetCalls: string[] = []; updateCalls: SaveNoteInput[] = []; events: string[] = [];
  private sessionListener?: (snapshot: CollectionSessionSnapshot) => void;
  sessionSnapshot(): CollectionSessionSnapshot { const current = connection(this.current); return { status: "ready", connection: current, connections: [connection("a"), connection("b")] }; }
  async startSession() { return this.sessionSnapshot(); }
  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void) { this.sessionListener = listener; listener(this.sessionSnapshot()); return () => { this.sessionListener = undefined; }; }
  emitSnapshot(snapshot: CollectionSessionSnapshot) { this.sessionListener?.(snapshot); }
  protected currentConnection() { return connection(this.current); }
  selectConnection(collectionId: string) { this.current = collectionId as "a" | "b"; return connection(this.current); }
  async authorize(_target: CollectionAuthorizationTarget) { this.authorizeCalls += 1; this.events.push("authorize"); await this.authorizeGate.promise; this.current = "b"; }
  forgetConnection(collectionId: string) { this.forgetCalls.push(collectionId); this.events.push("forget"); }
  async describe(): Promise<CollectionDescription> { this.describeCalls += 1; const id = this.current, base = await super.describe(); return { ...base, collectionId: id, displayName: id === "a" ? "Collection A" : "Collection B", types: base.types.map((type) => ({ ...type, name: id === "a" ? "alpha" : "bravo" })) }; }
  async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> { const value = this.documents[this.current], { revision: _revision, ...rest } = value, summary = { ...rest, file: { ...value.file, path: value.path } }; options.onProgress?.({ notes: [summary], snapshot: this.current, structureComplete: true, complete: true, contentComplete: true, contentLoaded: 1, total: 1 }); return { notes: [summary], snapshot: this.current }; }
  async hydrateContent(options: NoteIndexRequest = {}) { return this.list(options); }
  async read(_path: string) { return structuredClone(this.documents[this.current]); }
  async listFiles(): Promise<CollectionFile[]> { const [file] = await super.listFiles(); return [{ ...file!, path: `${this.current}.txt`, revision: `${this.current}-file` }]; }
  async update(input: SaveNoteInput) { const owner = this.current; this.updateCalls.push(input); this.events.push("update:start"); await this.updateGate.promise; const saved = { ...this.documents[owner], body: input.body, revision: `${owner}-2` }; this.documents[owner] = saved; this.events.push("update:end"); return structuredClone(saved); }
}

class HostileGateway extends SwitchGateway {
  createGate = deferred<void>(); uploadGate = deferred<void>();
  createOwners: string[] = []; uploadOwners: string[] = [];
  uploadProgress?: NonNullable<FileUploadRequest["onProgress"]>;
  async create(input: CreateNoteInput) {
    const owner = this.current; this.createOwners.push(owner); await this.createGate.promise;
    const body = `# ${input.title}\n\n${input.body}`;
    const created = { ...this.documents[owner], body, document: body, revision: `${owner}-created` };
    this.documents[owner] = created;
    return structuredClone(created);
  }
  async uploadFile(path: string, source: Parameters<DemoCollectionGateway["uploadFile"]>[1], options: FileUploadRequest = {}) {
    const owner = this.current; this.uploadOwners.push(owner); this.uploadProgress = options.onProgress;
    await this.uploadGate.promise;
    return super.uploadFile(path, source, options);
  }
}

async function requestSwitch(user: ReturnType<typeof userEvent.setup>) {
  const rail = screen.getByRole("complementary", { name: "Collection navigation" });
  await user.click(within(rail).getByRole("button", { name: /Switch collection/ }));
  await user.click(screen.getByRole("button", { name: "Connect another collection" }));
}

async function requestSavedSwitch(user: ReturnType<typeof userEvent.setup>) {
  const rail = screen.getByRole("complementary", { name: "Collection navigation" });
  await user.click(within(rail).getByRole("button", { name: /Switch collection/ }));
  await user.click(screen.getByRole("button", { name: /Collection B/ }));
  const confirm = screen.queryByRole("button", { name: "Switch collection" });
  if (confirm) await user.click(confirm);
}

async function hostileHarness() {
  const gateway = new HostileGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
  expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
  return { gateway, user };
}

async function finishSavedSwitch(gateway: HostileGateway) {
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"));
  expect(gateway.current).toBe("b");
}

describe("App collection switch ownership", () => {
  it("drains an ordinary A note creation before a saved switch and never publishes it into same-path B", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Hostile create");
    await user.type(screen.getByRole("textbox", { name: "Note body" }), "Owned by A");
    await user.click(screen.getByRole("button", { name: "Create note" }));
    await waitFor(() => expect(gateway.createOwners).toEqual(["a"]));

    await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Hostile create");
    gateway.createGate.resolve();
    await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    expect(screen.queryByDisplayValue("Hostile create")).not.toBeInTheDocument();
  });

  it("drains linked-note creation from the real App callback before switching A to B", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "Create hostile link" }));
    await waitFor(() => expect(gateway.createOwners).toEqual(["a"]));

    await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    gateway.createGate.resolve();
    await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    expect(screen.queryByDisplayValue("Linked")).not.toBeInTheDocument();
  });

  it("contains deferred A attachment progress, completion, and insertion across a saved switch", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Attach file…" }));
    const input = document.querySelector<HTMLInputElement>(".attachment-input");
    await user.upload(input!, new File(["pixels"], "hostile.png", { type: "image/png" }));
    await waitFor(() => expect(gateway.uploadOwners).toEqual(["a"]));
    act(() => gateway.uploadProgress?.({ phase: "uploading", transferredBytes: 2, totalBytes: 8 }));
    expect(screen.getByRole("progressbar", { name: "Attachment progress for hostile.png" })).toHaveValue(2);

    await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); expect(screen.getByRole("progressbar")).toHaveValue(2);
    gateway.uploadGate.resolve();
    await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    expect(screen.queryByLabelText("Editor insertion")).not.toBeInTheDocument();
    expect(screen.queryByText(/Uploaded “hostile\.png”/)).not.toBeInTheDocument();
    act(() => gateway.uploadProgress?.({ phase: "uploading", transferredBytes: 8, totalBytes: 8 }));
    expect(screen.queryByRole("progressbar", { name: "Attachment progress for hostile.png" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
  });

  it("flushes and freezes A before one shared authorization, then rejects stale same-path A publication", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); expect(body).toHaveValue("Alpha body");
    await user.type(body, " dirty");
    void requestSwitch(user);
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    expect(gateway.authorizeCalls).toBe(0);
    fireEvent.change(body, { target: { value: "forbidden edit" } });
    expect(gateway.updateCalls).toHaveLength(1); expect(gateway.updateCalls[0]?.body).toContain("Alpha body dirty");
    gateway.updateGate.resolve();
    await waitFor(() => expect(gateway.authorizeCalls).toBe(1));
    await requestSwitch(user); expect(gateway.authorizeCalls).toBe(1);
    gateway.authorizeGate.resolve();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"));
    expect(gateway.events.indexOf("update:end")).toBeLessThan(gateway.events.indexOf("authorize"));
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    act(() => gateway.emitSnapshot({ status: "ready", connection: connection("a"), connections: [connection("a"), connection("b")] }));
    expect(screen.getByRole("heading", { name: "Collection B" })).toBeInTheDocument();
  });

  it("serializes saved selection behind registered A work", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); await user.type(body, " saved selection");
    const rail = screen.getByRole("complementary", { name: "Collection navigation" });
    await user.click(within(rail).getByRole("button", { name: /Switch collection/ }));
    await user.click(screen.getByRole("button", { name: /Collection B/ }));
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    expect(gateway.current).toBe("a"); gateway.updateGate.resolve();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"));
  });

  it("routes authoritative startup events and same-collection reconnects through the draining transition", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.type(body, " pending lifecycle save");
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    gateway.current = "b";
    act(() => gateway.emitSnapshot(gateway.sessionSnapshot()));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    gateway.updateGate.resolve();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"));
    const starts = gateway.describeCalls;
    act(() => gateway.emitSnapshot(gateway.sessionSnapshot()));
    await waitFor(() => expect(gateway.describeCalls).toBeGreaterThan(starts));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note");
  });

  it("does not authorize or clear A when its required flush fails", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); await user.type(body, " unsaved");
    void requestSwitch(user); await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    await act(async () => { gateway.updateGate.reject(new Error("conflict")); await Promise.resolve(); await Promise.resolve(); });
    expect(gateway.authorizeCalls).toBe(0);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Alpha body unsaved");
    fireEvent.change(body, { target: { value: "Alpha body retry" } });
    await waitFor(() => expect(body).toHaveValue("Alpha body retry"));
  });
});
