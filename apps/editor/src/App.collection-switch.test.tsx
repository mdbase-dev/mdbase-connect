import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionAuthorizationTarget, CollectionFile, CollectionSessionSnapshot, ConnectionSummary, NoteDocument, NoteIndexRequest, NoteIndexResult, SaveNoteInput } from "./model";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) => <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} /> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const path = "Shared/same.md";
function note(collection: "a" | "b"): NoteDocument { const title = collection === "a" ? "Alpha note" : "Bravo note", body = `# ${title}\n\n${collection === "a" ? "Alpha body" : "Bravo body"}`; return { path, revision: `${collection}-1`, body, frontmatter: {}, effectiveFrontmatter: {}, types: [], document: body, file: { name: "same.md", folder: "Shared", size: body.length, mtime: "2026-01-01T00:00:00Z", tags: [], links: [], embeds: [] } }; }
function connection(id: "a" | "b"): ConnectionSummary { return { collectionId: id, displayName: id === "a" ? "Collection A" : "Collection B", operations: ["all"], missingCapabilities: [], fileActions: ["list", "read", "add", "replace", "move", "delete"] }; }

class SwitchGateway extends DemoCollectionGateway {
  current: "a" | "b" = "a";
  documents = { a: note("a"), b: note("b") };
  authorizeGate = deferred<void>(); updateGate = deferred<void>();
  authorizeCalls = 0; updateCalls: SaveNoteInput[] = []; events: string[] = [];
  private sessionListener?: (snapshot: CollectionSessionSnapshot) => void;
  sessionSnapshot(): CollectionSessionSnapshot { const current = connection(this.current); return { status: "ready", connection: current, connections: [connection("a"), connection("b")] }; }
  async startSession() { return this.sessionSnapshot(); }
  onSessionChange(listener: (snapshot: CollectionSessionSnapshot) => void) { this.sessionListener = listener; listener(this.sessionSnapshot()); return () => { this.sessionListener = undefined; }; }
  emitSnapshot(snapshot: CollectionSessionSnapshot) { this.sessionListener?.(snapshot); }
  protected currentConnection() { return connection(this.current); }
  async authorize(_target: CollectionAuthorizationTarget) { this.authorizeCalls += 1; this.events.push("authorize"); await this.authorizeGate.promise; this.current = "b"; }
  async describe(): Promise<CollectionDescription> { const id = this.current, base = await super.describe(); return { ...base, collectionId: id, displayName: id === "a" ? "Collection A" : "Collection B", types: base.types.map((type) => ({ ...type, name: id === "a" ? "alpha" : "bravo" })) }; }
  async list(options: NoteIndexRequest = {}): Promise<NoteIndexResult> { const value = this.documents[this.current], { revision: _revision, ...rest } = value, summary = { ...rest, file: { ...value.file, path: value.path } }; options.onProgress?.({ notes: [summary], snapshot: this.current, structureComplete: true, complete: true, contentComplete: true, contentLoaded: 1, total: 1 }); return { notes: [summary], snapshot: this.current }; }
  async hydrateContent(options: NoteIndexRequest = {}) { return this.list(options); }
  async read(_path: string) { return structuredClone(this.documents[this.current]); }
  async listFiles(): Promise<CollectionFile[]> { const [file] = await super.listFiles(); return [{ ...file!, path: `${this.current}.txt`, revision: `${this.current}-file` }]; }
  async update(input: SaveNoteInput) { const owner = this.current; this.updateCalls.push(input); this.events.push("update:start"); await this.updateGate.promise; const saved = { ...this.documents[owner], body: input.body, revision: `${owner}-2` }; this.documents[owner] = saved; this.events.push("update:end"); return structuredClone(saved); }
}

async function requestSwitch(user: ReturnType<typeof userEvent.setup>) {
  const rail = screen.getByRole("complementary", { name: "Collection navigation" });
  await user.click(within(rail).getByRole("button", { name: /Switch collection/ }));
  await user.click(screen.getByRole("button", { name: "Connect another collection" }));
}

describe("App collection switch ownership", () => {
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
