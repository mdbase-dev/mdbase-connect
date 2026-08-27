import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { markdownFragment } from "./markdown-fragments";
import { useEmbeddedNoteReferences } from "./note-embeds";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const target = { path: "Shared/target.md", title: "Target" };
const document = (body: string) => ({ path: target.path, revision: body, body, frontmatter: {}, effectiveFrontmatter: {}, types: [], document: body, file: { name: "target.md", folder: "Shared", size: body.length, mtime: "", tags: [], links: [], embeds: [] } });
const summary = (body?: string) => ({ ...document(body ?? ""), ...(body === undefined ? { body: undefined } : {}) });
function embedHarness(read: (path: string) => Promise<ReturnType<typeof document>>, body?: string) {
  const props = { gateway: { read }, owner: { collectionId: "a" as string | undefined, epoch: 1 }, notes: [summary(body)] };
  const hook = renderHook(() => useEmbeddedNoteReferences(props.gateway, props.owner, "![[Target]]", props.notes as never, [target], [], "Shared/source.md"));
  return { props, ...hook };
}

async function ready(result: { current: ReturnType<typeof useEmbeddedNoteReferences> }, text: string) {
  await waitFor(() => expect(result.current[0]).toMatchObject({ status: "ready", body: text }));
}

describe("Markdown transclusion fragments", () => {
  const body = [
    "# Plan",
    "",
    "Opening.",
    "",
    "## Decisions",
    "",
    "Use the shared parser.",
    "",
    "### Detail",
    "",
    "Keep source ranges. ^source-ranges",
    "",
    "## Later",
    "",
    "Ship it."
  ].join("\n");

  it("extracts a heading through its nested subsections", () => {
    expect(markdownFragment(body, "Decisions")).toBe([
      "## Decisions",
      "",
      "Use the shared parser.",
      "",
      "### Detail",
      "",
      "Keep source ranges. ^source-ranges"
    ].join("\n"));
  });

  it("extracts block references without exposing the block marker", () => {
    expect(markdownFragment(body, "^source-ranges")).toBe("Keep source ranges.");
  });

  it("reports missing fragments", () => {
    expect(markdownFragment(body, "Unknown")).toBeUndefined();
  });
});

describe("embedded note owner cache", () => {
  it("does not reuse a completed same-path document after A to B", async () => {
    const read = vi.fn(async () => document("A body"));
    const hook = embedHarness(read);
    await ready(hook.result, "A body");
    read.mockResolvedValue(document("B body"));
    hook.props.owner = { collectionId: "b", epoch: 2 }; hook.rerender();
    await ready(hook.result, "B body");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("starts a B read when the same path is pending in A", async () => {
    const a = deferred<ReturnType<typeof document>>(), b = deferred<ReturnType<typeof document>>();
    const read = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const hook = embedHarness(read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    hook.props.owner = { collectionId: "b", epoch: 2 }; hook.rerender();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => b.resolve(document("B body"))); await ready(hook.result, "B body");
    await act(async () => a.resolve(document("A body")));
    expect(hook.result.current[0]?.body).toBe("B body");
  });

  it.each(["success", "error"])("ignores late A %s publication", async (outcome) => {
    const late = deferred<ReturnType<typeof document>>();
    const read = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(document("B body"));
    const hook = embedHarness(read); await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    hook.props.owner = { collectionId: "b", epoch: 2 }; hook.rerender(); await ready(hook.result, "B body");
    await act(async () => outcome === "success" ? late.resolve(document("A body")) : late.reject(new Error("A failure")));
    expect(hook.result.current[0]).toMatchObject({ status: "ready", body: "B body" });
  });

  it("isolates rapid A1 to B to A2 reads resolved out of order", async () => {
    const a1 = deferred<ReturnType<typeof document>>(), b = deferred<ReturnType<typeof document>>(), a2 = deferred<ReturnType<typeof document>>();
    const read = vi.fn().mockReturnValueOnce(a1.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(a2.promise);
    const hook = embedHarness(read); await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    hook.props.owner = { collectionId: "b", epoch: 2 }; hook.rerender(); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    hook.props.owner = { collectionId: "a", epoch: 3 }; hook.rerender(); await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => { b.resolve(document("B body")); a1.resolve(document("A1 body")); });
    expect(hook.result.current[0]?.status).toBe("loading");
    await act(async () => a2.resolve(document("A2 body"))); await ready(hook.result, "A2 body");
  });

  it("invalidates on gateway replacement but reuses across same-owner metadata rerenders", async () => {
    const first = vi.fn(async () => document("first")), second = vi.fn(async () => document("second"));
    const hook = embedHarness(first); await ready(hook.result, "first");
    hook.props.owner = { collectionId: "a", epoch: 1 }; hook.rerender();
    expect(first).toHaveBeenCalledTimes(1);
    hook.props.gateway = { read: second }; hook.rerender(); await ready(hook.result, "second");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("prefers an indexed body and does not read", async () => {
    const read = vi.fn(async () => document("remote"));
    const hook = embedHarness(read, "indexed B"); await ready(hook.result, "indexed B");
    expect(read).not.toHaveBeenCalled();
  });
});
