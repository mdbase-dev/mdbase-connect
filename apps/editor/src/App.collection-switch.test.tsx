import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionAuthorizationTarget, CollectionFile, CollectionSessionSnapshot, ConnectionSummary, CreateNoteInput, FileUploadRequest, MutationOperationOptions, NoteDocument, NoteIndexRequest, NoteIndexResult, SaveNoteInput } from "./model";

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
  createGate = deferred<void>(); uploadGate = deferred<void>(); documentGate = deferred<void>();
  renamePreflightGate = deferred<void>(); renameGate = deferred<void>(); deletePreflightGate = deferred<void>(); deleteGate = deferred<void>();
  restoreGate = deferred<void>(); validateGate = deferred<void>();
  createOwners: string[] = []; uploadOwners: string[] = []; operationOwners: string[] = [];
  uploadProgress?: NonNullable<FileUploadRequest["onProgress"]>;
  renameProgress?: MutationOperationOptions["onProgress"]; deleteProgress?: MutationOperationOptions["onProgress"];
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
  async updateDocument(_path: string, document: string) {
    const owner = this.current; this.operationOwners.push(`document:${owner}`); await this.documentGate.promise;
    const saved = { ...this.documents[owner], document, body: document, revision: `${owner}-document` };
    this.documents[owner] = saved; return structuredClone(saved);
  }
  async preflightRename(from: string, to: string, _revision: string) {
    const owner = this.current; this.operationOwners.push(`rename-preflight:${owner}`); this.events.push("preflight:rename"); await this.renamePreflightGate.promise;
    return { affectedPaths: ["Shared/ref.md"], warnings: [], operation: { from, to, dryRun: true as const, wouldRename: true as const, referencesAffected: [{ path: "Shared/ref.md", location: "body" as const }] } };
  }
  async rename(_from: string, to: string, _revision: string, _updateRefs = true, options: MutationOperationOptions = {}) {
    const owner = this.current; this.operationOwners.push(`rename:${owner}`); this.renameProgress = options.onProgress; await this.renameGate.promise;
    const saved = { ...this.documents[owner], path: to, revision: `${owner}-renamed`, file: { ...this.documents[owner].file, name: to.split("/").at(-1)!, folder: to.split("/").slice(0, -1).join("/") } };
    this.documents[owner] = saved; return structuredClone(saved);
  }
  async preflightDelete(target: string, _revision: string) {
    const owner = this.current; this.operationOwners.push(`delete-preflight:${owner}`); await this.deletePreflightGate.promise;
    return { brokenLinkPaths: ["Shared/ref.md"], operation: { path: target, deleted: false as const, dryRun: true as const, wouldDelete: true as const, brokenLinks: [{ path: "Shared/ref.md" }] } };
  }
  async delete(_path: string, _revision: string, options: MutationOperationOptions = {}) {
    const owner = this.current; this.operationOwners.push(`delete:${owner}`); this.deleteProgress = options.onProgress; await this.deleteGate.promise;
  }
  async restore(document: NoteDocument) {
    const owner = this.current; this.operationOwners.push(`restore:${owner}`); await this.restoreGate.promise; return structuredClone(document);
  }
  async validate() {
    const owner = this.current; this.operationOwners.push(`validate:${owner}`); await this.validateGate.promise; return [];
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
  it("drains an A structured-properties save before switching to same-path B", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    await user.click(await screen.findByRole("button", { name: "Add property" }));
    await user.click(screen.getByRole("button", { name: "Add a custom property…" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "status");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "status value" }), "hostile-a");
    await waitFor(() => expect(gateway.operationOwners).toContain("document:a"), { timeout: 2_000 });
    await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    gateway.documentGate.resolve(); await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    expect(screen.queryByDisplayValue("hostile-a")).not.toBeInTheDocument();
  });

  it("drains an A complete-source save and cannot publish it into same-path B", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    await user.click(screen.getByRole("tab", { name: "Source" }));
    const source = screen.getByLabelText("Complete record source");
    fireEvent.change(source, { target: { value: "# Hostile source\n\nOwned by A" } });
    await user.click(screen.getByRole("button", { name: "Save source" }));
    await waitFor(() => expect(gateway.operationOwners).toContain("document:a"));
    await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); expect(source).toHaveValue("# Hostile source\n\nOwned by A");
    gateway.documentGate.resolve(); await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    expect(screen.queryByDisplayValue(/Hostile source/)).not.toBeInTheDocument();
  });

  it("drains A rename preflight before a saved switch and preserves save-before-preflight ordering", async () => {
    const { gateway, user } = await hostileHarness();
    await user.type(screen.getByRole("textbox", { name: "Note body" }), " dirty");
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: path }));
    const pathInput = screen.getByRole("textbox", { name: "Markdown path" }); await user.clear(pathInput); await user.type(pathInput, "Shared/renamed.md{Enter}");
    expect(gateway.operationOwners).not.toContain("rename-preflight:a");
    gateway.updateGate.resolve(); await waitFor(() => expect(gateway.operationOwners).toContain("rename-preflight:a"));
    expect(gateway.events.indexOf("update:end")).toBeLessThan(gateway.events.indexOf("preflight:rename"));
    await requestSavedSwitch(user); expect(gateway.current).toBe("a"); expect(pathInput).toHaveValue("Shared/renamed.md");
    gateway.renamePreflightGate.resolve(); await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body"); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drains A rename apply and ignores completion and late progress after B", async () => {
    const { gateway, user } = await hostileHarness(); gateway.renamePreflightGate.resolve();
    await user.click(screen.getByRole("button", { name: path })); const pathInput = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(pathInput); await user.type(pathInput, "Shared/renamed.md{Enter}");
    await user.click(await screen.findByRole("button", { name: "Rename and update links" }));
    await waitFor(() => expect(gateway.operationOwners).toContain("rename:a"));
    await requestSavedSwitch(user); expect(gateway.current).toBe("a"); expect(pathInput).toHaveValue("Shared/renamed.md");
    gateway.renameGate.resolve(); await finishSavedSwitch(gateway);
    act(() => gateway.renameProgress?.({ operation: "rename", state: "applying", elapsedMs: 50, cancellable: false, resumed: false, completedUnits: 1, estimate: { affectedRecords: 9, totalUnits: 10, warnings: 0 } }));
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body"); expect(screen.queryByText(/Updating 9 linked notes/)).not.toBeInTheDocument();
  });

  it("drains A delete preflight before switching and does not publish its confirmation in B", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "More note actions" })); await user.click(screen.getByRole("menuitem", { name: "Delete note" }));
    await waitFor(() => expect(gateway.operationOwners).toContain("delete-preflight:a"));
    await requestSavedSwitch(user); expect(gateway.current).toBe("a"); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    gateway.deletePreflightGate.resolve(); await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body"); expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("drains A delete apply and ignores its completion and late progress in B", async () => {
    const { gateway, user } = await hostileHarness(); gateway.deletePreflightGate.resolve();
    await user.click(screen.getByRole("button", { name: "More note actions" })); await user.click(screen.getByRole("menuitem", { name: "Delete note" }));
    await user.click(await screen.findByRole("button", { name: "Delete" })); await waitFor(() => expect(gateway.operationOwners).toContain("delete:a"));
    await requestSavedSwitch(user); expect(gateway.current).toBe("a");
    gateway.deleteGate.resolve(); await finishSavedSwitch(gateway);
    act(() => gateway.deleteProgress?.({ operation: "delete", state: "applying", elapsedMs: 50, cancellable: false, resumed: false, completedUnits: 0, estimate: { affectedRecords: 9, totalUnits: 10, warnings: 0 } }));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"); expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("drains A restore from the public Undo action before switching to B", async () => {
    const { gateway, user } = await hostileHarness(); gateway.deletePreflightGate.resolve(); gateway.deleteGate.resolve();
    await user.click(screen.getByRole("button", { name: "More note actions" })); await user.click(screen.getByRole("menuitem", { name: "Delete note" }));
    await user.click(await screen.findByRole("button", { name: "Delete" })); await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(gateway.operationOwners).toContain("restore:a")); await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); gateway.restoreGate.resolve(); await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body"); expect(screen.queryByText(/restored/i)).not.toBeInTheDocument();
  });

  it("drains A validation and suppresses its result after B becomes authoritative", async () => {
    const { gateway, user } = await hostileHarness();
    await user.click(screen.getByRole("button", { name: "More note actions" })); await user.click(screen.getByRole("menuitem", { name: "Check note" }));
    await waitFor(() => expect(gateway.operationOwners).toContain("validate:a")); await requestSavedSwitch(user);
    expect(gateway.current).toBe("a"); gateway.validateGate.resolve(); await finishSavedSwitch(gateway);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body"); expect(screen.queryByText("No validation issues.")).not.toBeInTheDocument();
  });

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
