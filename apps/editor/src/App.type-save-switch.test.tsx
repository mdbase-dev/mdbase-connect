import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionSessionSnapshot, ConnectionSummary, NoteIndexRequest, TypeDocument } from "./model";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) => <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} /> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Owner = "a" | "b" | "c";
const names = { a: "Collection A", b: "Collection B", c: "Collection C" };
function connection(owner: Owner): ConnectionSummary { return { collectionId: owner, displayName: names[owner], operations: ["all"], missingCapabilities: [], fileActions: ["list", "read", "add", "replace", "move", "delete"] }; }
function source(owner: Owner, marker = `${owner.toUpperCase()} baseline`) { return `---\nkind: mdbase.type\nname: note\ndescription: ${marker}\nfields: {}\n---\n`; }
function document(owner: Owner, path = `_types/${owner}-note.md`, revision = `${owner}-revision`): TypeDocument { return { name: "note", path, revision, document: source(owner) }; }

class TypeSwitchGateway extends DemoCollectionGateway {
  current: Owner = "a";
  stores: Record<Owner, TypeDocument>;
  saveGates: Partial<Record<Owner, ReturnType<typeof deferred<TypeDocument>>>> = {};
  describeGates: Partial<Record<Owner, ReturnType<typeof deferred<void>>>> = {};
  calls: Array<{ operation: "readType" | "updateType" | "describe"; owner: Owner; path?: string; ifRevision?: string; document?: string }> = [];
  constructor(paths: Partial<Record<Owner, string>> = {}, revisions: Partial<Record<Owner, string>> = {}) {
    super(1); this.stores = { a: document("a", paths.a, revisions.a), b: document("b", paths.b, revisions.b), c: document("c", paths.c, revisions.c) };
  }
  protected currentConnection() { return connection(this.current); }
  sessionSnapshot(): CollectionSessionSnapshot { const connections = (["a", "b", "c"] as Owner[]).map(connection); return { status: "ready", connection: connection(this.current), connections }; }
  async startSession() { return this.sessionSnapshot(); }
  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void) { listener(this.sessionSnapshot()); return () => undefined; }
  selectConnection(id: string) { this.current = id as Owner; return connection(this.current); }
  async describe(): Promise<CollectionDescription> { const owner = this.current; this.calls.push({ operation: "describe", owner }); await this.describeGates[owner]?.promise; const base = await super.describe(); return { ...base, collectionId: owner, displayName: names[owner], types: base.types.map((type) => ({ ...type, name: "note" })) }; }
  async read(path: string) { const owner = this.current; const value = await super.read(path); return { ...value, frontmatter: { ...value.frontmatter, title: names[owner] }, effectiveFrontmatter: { ...value.effectiveFrontmatter, title: names[owner] } }; }
  async readType(_name: string) { const owner = this.current; const value = structuredClone(this.stores[owner]); this.calls.push({ operation: "readType", owner, path: value.path }); return value; }
  async updateType(current: TypeDocument, next: string) {
    const owner = this.current; this.calls.push({ operation: "updateType", owner, path: current.path, ifRevision: current.revision, document: next });
    const saved = { ...current, revision: `${owner}-saved`, document: next }; this.stores[owner] = structuredClone(saved);
    const gate = this.saveGates[owner]; if (gate) return gate.promise; return saved;
  }
  async list(options: NoteIndexRequest = {}) { const owner = this.current; const decorate = <T extends { frontmatter?: Record<string, unknown>; effectiveFrontmatter?: Record<string, unknown>; body?: string; document?: string }>(value: T) => ({ ...value, frontmatter: { ...value.frontmatter, title: names[owner] }, effectiveFrontmatter: { ...value.effectiveFrontmatter, title: names[owner] }, body: `# ${names[owner]}\n`, document: `# ${names[owner]}\n` }); const result = await super.list({ ...options, onProgress: (update) => options.onProgress?.({ ...update, notes: update.notes.map(decorate) }) }); return { ...result, notes: result.notes.map(decorate), snapshot: owner }; }
  async hydrateContent(options: NoteIndexRequest = {}) { const owner = this.current; const decorate = <T extends { frontmatter?: Record<string, unknown>; effectiveFrontmatter?: Record<string, unknown>; body?: string; document?: string }>(value: T) => ({ ...value, frontmatter: { ...value.frontmatter, title: names[owner] }, effectiveFrontmatter: { ...value.effectiveFrontmatter, title: names[owner] }, body: `# ${names[owner]}\n`, document: `# ${names[owner]}\n` }); const result = await super.hydrateContent({ ...options, onProgress: (update) => options.onProgress?.({ ...update, notes: update.notes.map(decorate) }) }); return { ...result, notes: result.notes.map(decorate) }; }
}

async function openType(user: ReturnType<typeof userEvent.setup>) {
  const rail = await screen.findByRole("complementary", { name: "Collection navigation" });
  await user.click(await within(rail).findByRole("button", { name: "Types (1)" }));
  await user.click(await screen.findByRole("button", { name: "YAML" }));
  return screen.findByRole("textbox", { name: "note type YAML" });
}
async function switchTo(gateway: TypeSwitchGateway, user: ReturnType<typeof userEvent.setup>, owner: Owner) {
  const rail = screen.getByRole("complementary", { name: "Collection navigation" });
  await user.click(within(rail).getByRole("button", { name: /Switch collection/ }));
  await user.click(screen.getByRole("button", { name: new RegExp(names[owner]) }));
  const confirm = await screen.findByRole("button", { name: "Switch collection" }, { timeout: 300 }).catch(() => undefined); if (confirm) await user.click(confirm);
  await waitFor(() => expect(gateway.current).toBe(owner));
  await waitFor(() => expect(gateway.calls).toContainEqual({ operation: "describe", owner }));
  await screen.findByRole("heading", { name: names[owner] });
  const readyRail = screen.getByRole("complementary", { name: "Collection navigation" });
  await waitFor(() => expect(within(readyRail).getByRole("button", { name: "Types (1)" })).toBeEnabled());
  await user.click(within(readyRail).getByRole("button", { name: "Types (1)" }));
  await user.click(await screen.findByRole("button", { name: "YAML" }));
}
async function save(textarea: HTMLElement, owner: Owner, marker: string, user: ReturnType<typeof userEvent.setup>) {
  fireEvent.change(textarea, { target: { value: source(owner, marker) } });
  await user.click(screen.getByRole("button", { name: "Review changes" }));
  await user.click(screen.getByRole("button", { name: "Confirm update" }));
}
async function visible(owner: Owner) {
  expect(screen.getByText(names[owner])).toBeInTheDocument();
  const yaml = await screen.findByRole("textbox", { name: "note type YAML" });
  await waitFor(() => expect(yaml).toHaveValue(source(owner)));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  return yaml;
}

describe("App detached type-save collection ownership", () => {
  it("ignores deferred A success after B baseline is visibly ready, then saves exact B source/path/revision", async () => {
    const gateway = new TypeSwitchGateway(); const gate = deferred<TypeDocument>(); gateway.saveGates.a = gate;
    const user = userEvent.setup(); render(<App gateway={gateway} />); const yamlA = await openType(user); await save(yamlA, "a", "A hostile edit", user);
    await waitFor(() => expect(screen.getByText("Saving…")).toBeInTheDocument()); await switchTo(gateway, user, "b"); const yamlB = await visible("b");
    await act(async () => gate.resolve(gateway.stores.a)); expect(yamlB).toHaveValue(source("b")); expect(screen.queryByText(/Saved type/)).not.toBeInTheDocument();
    await save(yamlB, "b", "B own edit", user); await waitFor(() => expect(gateway.calls.filter((call) => call.operation === "updateType")).toHaveLength(2));
    const bSave = gateway.calls.filter((call) => call.operation === "updateType")[1];
    expect(bSave).toEqual({ operation: "updateType", owner: "b", path: "_types/b-note.md", ifRevision: "b-revision", document: source("b", "B own edit") });
    expect(bSave?.document).not.toContain("A hostile edit");
  });

  it("ignores a unique deferred A rejection after B is ready", async () => {
    const gateway = new TypeSwitchGateway(); const gate = deferred<TypeDocument>(); gateway.saveGates.a = gate;
    const user = userEvent.setup(); render(<App gateway={gateway} />); await save(await openType(user), "a", "A rejected", user); await switchTo(gateway, user, "b"); const yamlB = await visible("b");
    await act(async () => gate.reject(new Error("UNIQUE STALE A"))); expect(yamlB).toHaveValue(source("b")); expect(screen.queryByText(/UNIQUE STALE A/)).not.toBeInTheDocument(); expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });

  it.each([
    ["no A save", false, undefined, undefined], ["A completes before switch", true, undefined, undefined],
    ["same path/same revision", true, "_types/shared.md", "shared"], ["distinct path", true, "_types/a-only.md", "shared"],
    ["same path/distinct revision", true, "_types/shared.md", "a-only"]
  ])("control: %s", async (_label, saveA, aPath, aRevision) => {
    const paths = aPath ? { a: aPath, b: aPath === "_types/shared.md" ? aPath : "_types/b-only.md" } : {};
    const revisions = aRevision ? { a: aRevision, b: aRevision === "shared" ? aRevision : "b-only" } : {};
    const gateway = new TypeSwitchGateway(paths, revisions); const user = userEvent.setup(); render(<App gateway={gateway} />); const yaml = await openType(user); if (saveA) await save(yaml, "a", "A completed", user);
    if (saveA) await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument()); await switchTo(gateway, user, "b"); expect(await visible("b")).toHaveValue(source("b"));
  });

  it("survives hostile A to B to C while A remains pending", async () => {
    const gateway = new TypeSwitchGateway(); const gate = deferred<TypeDocument>(); gateway.saveGates.a = gate; const user = userEvent.setup(); render(<App gateway={gateway} />);
    await save(await openType(user), "a", "A hostile", user); await switchTo(gateway, user, "b"); await visible("b"); await switchTo(gateway, user, "c"); const yamlC = await visible("c"); await act(async () => gate.resolve(gateway.stores.a)); expect(yamlC).toHaveValue(source("c"));
  });

  it("keeps B visibly saving when stale A resolves first, and only B publishes", async () => {
    const gateway = new TypeSwitchGateway(); const a = deferred<TypeDocument>(), b = deferred<TypeDocument>(); gateway.saveGates = { a, b }; const user = userEvent.setup(); render(<App gateway={gateway} />);
    await save(await openType(user), "a", "A pending", user); await switchTo(gateway, user, "b"); const yamlB = await visible("b"); await save(yamlB, "b", "B pending", user); expect(screen.getByText("Saving…")).toBeInTheDocument();
    await act(async () => a.resolve(gateway.stores.a)); expect(screen.getByText("Saving…")).toBeInTheDocument(); expect(screen.queryByText(/Saved type/)).not.toBeInTheDocument();
    await act(async () => b.resolve(gateway.stores.b)); await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument()); expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });
});
