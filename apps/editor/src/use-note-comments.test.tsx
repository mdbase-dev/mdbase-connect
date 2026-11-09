import type { CollectionDescription } from "@mdbase-dev/connect";
import { describe, expect, it, vi } from "vitest";
import type { CollectionGateway, CreateNoteInput, NoteDocument, NoteSummary } from "./model";
import type { Draft } from "./note-session";
import { act, renderHook, waitFor } from "./test/locale";
import { useNoteComments, type CommentSurface } from "./use-note-comments";

const description = { collectionId: "c1", contracts: [{ contractType: "record", id: "mdbase.comment", version: "1.0.0", implementations: [
  { typeName: "comment", typeVersion: 1, digest: "sha256:0", fields: { document: "document", in_reply_to: "in_reply_to", motivation: "motivation", target: "target", suggestion: "suggestion", status: "status", resolved_at: "resolved_at", resolved_by: "resolved_by", created_at: "created_at", created_by: "created_by" } },
] }] } as unknown as CollectionDescription;
const note = (path: string, types: string[], frontmatter: NoteSummary["frontmatter"], body?: string): NoteSummary =>
  ({ path, body, types, frontmatter, effectiveFrontmatter: frontmatter, revision: "r1", file: { path, name: path, folder: "", size: 0, mtime: "" } });
const document = (summary: NoteSummary, body: string): NoteDocument => ({ ...summary, body, revision: summary.revision ?? "r1" }) as NoteDocument;

function surface(selection?: { from: number; to: number }) {
  return { panelOpen: true, openPanel: vi.fn<() => void>(), canWrite: true, selection: () => selection, applyBody: vi.fn<(body: string) => void>() } satisfies CommentSurface;
}

function setup(notes: NoteSummary[], draft: Draft, gateway: Partial<CollectionGateway> = {}, on = surface()) {
  const indexController = { create: vi.fn(), upsert: vi.fn() };
  const create = vi.fn(async (input: CreateNoteInput) => document(note(input.path, ["comment"], input.properties as NoteSummary["frontmatter"]), input.body));
  const collection = { create, peopleDirectory: async () => ({ me: { status: "unlinked" }, people: [] }), ...gateway } as unknown as CollectionGateway;
  const hook = renderHook(() => useNoteComments({
    gateway: collection,
    description, notes, path: "notes/a.md", draft, indexController, surface: on,
  }));
  return { ...hook, create, indexController, on };
}

describe("useNoteComments", () => {
  it("is unavailable in a collection without a comment type", () => {
    const options = { gateway: {} as CollectionGateway, description: { contracts: [] } as unknown as CollectionDescription, notes: [], path: "notes/a.md", draft: undefined, indexController: { create: vi.fn(), upsert: vi.fn() }, surface: surface() };
    const { result } = renderHook(() => useNoteComments(options));
    expect(result.current.available).toBe(false);
    expect(result.current.canWrite).toBe(false);
  });

  it("anchors a new comment in the stored body, past the heading the editor shows as the title", async () => {
    const draft: Draft = { title: "Alpha", body: "One two three.", source: { kind: "heading" } };
    const { result, create, indexController, on } = setup([note("notes/a.md", ["note"], {}, "# Alpha\n\nOne two three.")], draft, {}, surface({ from: 4, to: 7 }));
    act(() => result.current.start());
    expect(on.openPanel).toHaveBeenCalled();
    expect(result.current.pending).toEqual({ quote: "two" });
    let outcome;
    await act(async () => { outcome = await result.current.submit("  Why two?  "); });
    expect(outcome).toEqual({ ok: true });
    expect(result.current.pending).toBeNull();
    const input = create.mock.calls[0]![0];
    expect(input).toMatchObject({ type: "comment", body: "Why two?", title: "", titleField: "document" });
    expect(input.path).toMatch(/^comments\/.+\.md$/);
    expect(input.properties).toMatchObject({
      document: "[[notes/a]]", motivation: "commenting", status: "open",
      target: { quote: { exact: "two" }, text_position: { start: 13, end: 16 } },
    });
    expect(input.properties).not.toHaveProperty("created_by");
    expect(indexController.create).toHaveBeenCalledWith(expect.objectContaining({ path: input.path }));
  });

  it("shows an open thread where its passage is in the editor's text, reading a body the index lacks", async () => {
    const draft: Draft = { title: "Alpha", body: "One two three.", source: { kind: "heading" } };
    const comment = note("comments/1.md", ["comment"], { document: "[[notes/a]]", motivation: "commenting", status: "open", created_at: "2026-11-10T00:00:00Z", target: { quote: { exact: "two" }, text_position: { basis: { profile: "markdown-body", hash: "sha256:0" }, unit: "unicode_code_point", start: 13, end: 16 } } });
    const read = vi.fn(async () => document(comment, "Why two?"));
    const { result } = setup([note("notes/a.md", ["note"], {}), comment], draft, { read });
    await waitFor(() => expect(result.current.threads[0]?.thread.root.text).toBe("Why two?"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.editor.commentAnchors).toMatchObject([{ id: "comments/1.md", target: { quote: { exact: "two" }, text_position: { start: 4, end: 7 } } }]);
    expect(result.current.threads[0]!.at).toEqual({ from: 13, to: 16 });
  });

  it("resolves a comment against what is stored now", async () => {
    const draft: Draft = { title: "Alpha", body: "One two three.", source: { kind: "frontmatter", field: "title" } as Draft["source"] };
    const comment = note("comments/1.md", ["comment"], { document: "[[notes/a]]", motivation: "commenting", status: "open", created_at: "2026-11-10T00:00:00Z" }, "Whole note");
    const update = vi.fn(async (base: NoteDocument, change: { patch?: object }) => ({ ...base, frontmatter: { ...base.frontmatter, ...change.patch }, effectiveFrontmatter: { ...base.frontmatter, ...change.patch } }) as NoteDocument);
    const { result, indexController } = setup([note("notes/a.md", ["note"], {}), comment], draft, { read: async () => document(comment, "Whole note"), update: update as never });
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    await act(async () => { expect(await result.current.change(result.current.threads[0]!.thread.root, { kind: "resolve" })).toEqual({ ok: true }); });
    expect(update.mock.calls[0]![1].patch).toMatchObject({ status: "resolved" });
    expect(indexController.upsert).toHaveBeenCalledWith(expect.objectContaining({ path: "comments/1.md" }));
  });

  it("makes a suggested edit in the body the editor shows, and resolves it as accepted", async () => {
    const draft: Draft = { title: "Alpha", body: "One two three.", source: { kind: "heading" } };
    const suggestion = note("comments/1.md", ["comment"], { document: "[[notes/a]]", motivation: "editing", status: "open", created_at: "2026-11-10T00:00:00Z", target: { quote: { exact: "two" } }, suggestion: { replacement: "2" } }, "");
    const update = vi.fn(async (base: NoteDocument, _change: { patch?: object }) => base);
    const { result, on } = setup([note("notes/a.md", ["note"], {}), suggestion], draft, { read: async () => document(suggestion, ""), update: update as never });
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    await act(async () => { expect(await result.current.accept(result.current.threads[0]!)).toEqual({ ok: true }); });
    expect(on.applyBody).toHaveBeenCalledWith("One 2 three.");
    expect(update.mock.calls[0]![1]).toMatchObject({ patch: { status: "resolved", suggestion: { outcome: "accepted" } } });
  });
});
