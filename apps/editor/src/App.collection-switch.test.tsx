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
type CollectionId = "a" | "b" | "c";
function note(collection: CollectionId): NoteDocument { const titles = { a: "Alpha note", b: "Bravo note", c: "Charlie note" }, bodies = { a: "Alpha body", b: "Bravo body", c: "Charlie body" }; const title = titles[collection], body = `# ${title}\n\n${bodies[collection]}`; return { path, revision: `${collection}-1`, body, frontmatter: {}, effectiveFrontmatter: {}, types: [], document: body, file: { name: "same.md", folder: "Shared", size: body.length, mtime: "2026-01-01T00:00:00Z", tags: [], links: [], embeds: [] } }; }
function connection(id: CollectionId, missingCapabilities: string[] = []): ConnectionSummary { const names = { a: "Collection A", b: "Collection B", c: "Collection C" }; return { collectionId: id, displayName: names[id], operations: missingCapabilities.length ? [] : ["all"], missingCapabilities, fileActions: missingCapabilities.length ? ["list"] : ["list", "read", "add", "replace", "move", "delete"] }; }

class SwitchGateway extends DemoCollectionGateway {
  current: CollectionId = "a";
  documents = { a: note("a"), b: note("b"), c: note("c") };
  authorizeGate = deferred<void>(); forgetGate = deferred<void>(); updateGate = deferred<void>();
  authorizeCalls = 0; authorizeTargets: Array<{ target: CollectionAuthorizationTarget; selected: string }> = [];
  describeCalls = 0; forgetCalls: string[] = []; updateCalls: SaveNoteInput[] = []; events: string[] = []; selections: string[] = [];
  bMissingCapabilities: string[] = []; forgotten = false;
  private sessionListener?: (snapshot: CollectionSessionSnapshot) => void;
  sessionSnapshot(): CollectionSessionSnapshot {
    if (this.forgotten) return { status: "unselected", connections: [connection("b", this.bMissingCapabilities), connection("c")] };
    const current = connection(this.current, this.current === "b" ? this.bMissingCapabilities : []);
    return { status: "ready", connection: current, connections: [connection("a"), connection("b", this.bMissingCapabilities), connection("c")] };
  }
  async startSession() { return this.sessionSnapshot(); }
  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void) { this.sessionListener = listener; listener(this.sessionSnapshot()); return () => { this.sessionListener = undefined; }; }
  emitSnapshot(snapshot: CollectionSessionSnapshot) { this.sessionListener?.(snapshot); }
  protected currentConnection() { return connection(this.current); }
  selectConnection(collectionId: string) { this.current = collectionId as CollectionId; this.forgotten = false; this.selections.push(collectionId); this.events.push(`select:${collectionId}`); return connection(this.current, this.current === "b" ? this.bMissingCapabilities : []); }
  async authorize(target: CollectionAuthorizationTarget) {
    this.authorizeCalls += 1; this.authorizeTargets.push({ target, selected: this.current }); this.events.push("authorize");
    await this.authorizeGate.promise; this.current = "b"; this.bMissingCapabilities = [];
  }
  async forgetConnection(collectionId: string) {
    this.forgetCalls.push(collectionId); this.events.push("forget:start"); await this.forgetGate.promise;
    this.forgotten = true; this.events.push("forget:end"); this.emitSnapshot(this.sessionSnapshot());
  }
  async describe(): Promise<CollectionDescription> { this.describeCalls += 1; const id = this.current, base = await super.describe(); const names = { a: "Collection A", b: "Collection B", c: "Collection C" }, types = { a: "alpha", b: "bravo", c: "charlie" }; return { ...base, collectionId: id, displayName: names[id], types: base.types.map((type) => ({ ...type, name: types[id] })) }; }
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

async function finishSavedSwitch(gateway: SwitchGateway) {
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

  it("single-flights overlapping choose requests, freezes A through its drain, and opens the exact authorized B", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); expect(body).toHaveValue("Alpha body");
    await user.type(body, " dirty");
    void requestSwitch(user);
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    expect(gateway.authorizeCalls).toBe(0);
    fireEvent.change(body, { target: { value: "forbidden edit" } });
    expect(gateway.updateCalls).toHaveLength(1); expect(gateway.updateCalls[0]?.body).toContain("Alpha body dirty");
    gateway.updateGate.resolve();
    await waitFor(() => expect(gateway.authorizeTargets).toEqual([{ target: "choose", selected: "a" }]));
    await requestSwitch(user);
    expect(gateway.authorizeTargets).toEqual([{ target: "choose", selected: "a" }]);
    expect(gateway.current).toBe("a"); expect(body).toHaveValue("Alpha body dirty");
    gateway.authorizeGate.resolve();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"));
    expect(gateway.events.indexOf("update:end")).toBeLessThan(gateway.events.indexOf("authorize"));
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("Bravo body");
    act(() => gateway.emitSnapshot({ status: "ready", connection: connection("a"), connections: [connection("a"), connection("b")] }));
    expect(screen.getByRole("heading", { name: "Collection B" })).toBeInTheDocument();
  });

  it("keeps the existing saved-selection path explicit and serializes it behind registered A work", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); await user.type(body, " saved selection");
    void requestSavedSwitch(user);
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    expect(gateway.current).toBe("a"); expect(gateway.authorizeCalls).toBe(0);
    gateway.updateGate.resolve();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note"));
    expect(gateway.current).toBe("b"); expect(gateway.authorizeCalls).toBe(0);
  });

  it("executes rapid saved selections A to B to C in order and ends on exact C authority", async () => {
    class QueuedSelectionGateway extends SwitchGateway {
      bStartGate = deferred<void>();
      override async describe() {
        if (this.current === "b") { this.events.push("start:b"); await this.bStartGate.promise; }
        const result = await super.describe(); this.events.push(`start:${this.current}:end`); return result;
      }
    }
    const gateway = new QueuedSelectionGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    const rail = screen.getByRole("complementary", { name: "Collection navigation" });
    await user.click(within(rail).getByRole("button", { name: /Switch collection/ }));
    const b = screen.getByRole("button", { name: /Collection B/ }), c = screen.getByRole("button", { name: /Collection C/ });
    act(() => { fireEvent.click(b); fireEvent.click(c); });
    await waitFor(() => expect(gateway.events).toContain("start:b"));
    expect(gateway.selections).toEqual(["b"]); gateway.bStartGate.resolve();
    await waitFor(() => expect(gateway.selections).toEqual(["b", "c"]));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Charlie note"));
    expect(gateway.events.indexOf("start:b:end")).toBeLessThan(gateway.events.indexOf("select:c"));
    const snapshot = gateway.sessionSnapshot(); expect(snapshot.status).toBe("ready");
    if (snapshot.status === "ready") expect(snapshot.connection.collectionId).toBe("c");
  });

  it("single-flights selected authorization for saved B, holds the transition frozen, and revalidates B authority at execution", async () => {
    const gateway = new SwitchGateway(); gateway.bMissingCapabilities = ["records.update"];
    const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); await user.type(body, " pending selected auth");
    void requestSavedSwitch(user);
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    expect(gateway.current).toBe("a"); gateway.updateGate.resolve();
    await waitFor(() => expect(gateway.authorizeTargets).toEqual([{ target: "selected", selected: "b" }]));
    await requestSavedSwitch(user);
    expect(gateway.authorizeTargets).toEqual([{ target: "selected", selected: "b" }]);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    act(() => gateway.emitSnapshot({ status: "ready", connection: connection("a"), connections: [connection("a"), connection("b", ["records.update"])] }));
    expect(gateway.current).toBe("b"); expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    gateway.authorizeGate.resolve(); await finishSavedSwitch(gateway);
    expect(gateway.authorizeTargets).toEqual([{ target: "selected", selected: "b" }]);
    expect(screen.getByRole("heading", { name: "Collection B" })).toBeInTheDocument();
  });

  it("forgets active A only after its drain and rejects stale A completion and events from the ownerless snapshot", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" }); await user.type(body, " before forget");
    await user.click(within(screen.getByRole("complementary", { name: "Collection navigation" })).getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Forget from this browser" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Forget from this browser" }));
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    expect(gateway.forgetCalls).toEqual([]); expect(screen.getByRole("button", { name: /current collection Collection A/ })).toBeInTheDocument();
    gateway.updateGate.resolve(); await waitFor(() => expect(gateway.forgetCalls).toEqual(["a"]));
    expect(gateway.forgotten).toBe(false); gateway.forgetGate.resolve();
    expect(await screen.findByRole("button", { name: "Connect another collection" })).toBeInTheDocument();
    expect(gateway.sessionSnapshot()).toEqual({ status: "unselected", connections: [connection("b"), connection("c")] });
    act(() => gateway.emitSnapshot({ status: "ready", connection: connection("a"), connections: [connection("a"), connection("b")] }));
    expect(screen.getByRole("button", { name: "Connect another collection" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Collection A" })).not.toBeInTheDocument();
  });

  it("serializes an active forget, overlapping reconnect event, and the next public saved selection to exact C", async () => {
    const gateway = new SwitchGateway(); const user = userEvent.setup(); render(<App gateway={gateway} />);
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("Alpha note");
    await user.click(within(screen.getByRole("complementary", { name: "Collection navigation" })).getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Forget from this browser" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Forget from this browser" }));
    await waitFor(() => expect(gateway.forgetCalls).toEqual(["a"]));
    act(() => gateway.emitSnapshot({ status: "ready", connection: connection("b"), connections: [connection("b"), connection("c")] }));
    expect(screen.queryByRole("button", { name: /Collection C/ })).not.toBeInTheDocument();
    gateway.forgetGate.resolve();
    const c = (await screen.findAllByRole("button", { name: /Collection C/ })).find((button) => button.classList.contains("saved-collection-row"));
    expect(c).toBeDefined(); await user.click(c!);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Charlie note"));
    expect(gateway.events).toEqual(["forget:start", "forget:end", "select:c"]);
    const snapshot = gateway.sessionSnapshot(); expect(snapshot.status).toBe("ready");
    if (snapshot.status === "ready") expect(snapshot.connection.collectionId).toBe("c");
  });

  it("rejects stale ready and non-ready A events after B and serializes an exact-B reconnect startup", async () => {
    const { gateway, user } = await hostileHarness();
    gateway.updateGate.resolve(); await requestSavedSwitch(user); await finishSavedSwitch(gateway);
    const stale: CollectionSessionSnapshot[] = [
      { status: "ready", connection: connection("a"), connections: [connection("a"), connection("b")] },
      { status: "unavailable", collectionId: "a", reason: "authorization_lost", connections: [connection("a"), connection("b")] },
      { status: "start_failed", problem: { message: "stale A", recovery: "retry" }, connections: [connection("a"), connection("b")] },
      { status: "destroyed", connections: [connection("a")] }
    ];
    for (const snapshot of stale) {
      act(() => gateway.emitSnapshot(snapshot));
      expect(screen.getByRole("heading", { name: "Collection B" })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Bravo note");
    }
    gateway.updateGate = deferred<void>();
    const body = screen.getByRole("textbox", { name: "Note body" }); await user.type(body, " reconnect drain");
    await waitFor(() => expect(gateway.updateCalls).toHaveLength(1));
    const starts = gateway.describeCalls;
    act(() => gateway.emitSnapshot(gateway.sessionSnapshot()));
    expect(gateway.describeCalls).toBe(starts); gateway.updateGate.resolve();
    await waitFor(() => expect(gateway.describeCalls).toBeGreaterThan(starts));
    expect(gateway.sessionSnapshot()).toEqual({ status: "ready", connection: connection("b"), connections: [connection("a"), connection("b"), connection("c")] });
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
