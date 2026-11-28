import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "./test/locale";
import { DRAFT_CHECKPOINT_IDLE_MS, DraftRecovery, DRAFT_RETENTION_MS, frontmatterPatch, useDraftRecovery } from "./draft-recovery";

const draft = { body: "Unsent text", baseBody: "Original", patch: { title: "New" }, baseFrontmatter: { title: "Old" } };
const ignored = () => {};

/** Checkpoint without waiting for a pause in writing. */
function checkpoint(store: DraftRecovery, collection: string, path: string, value = draft) {
  store.write(collection, path, value, ignored);
  store.flush();
}

it("keeps unsent content across reloads, isolated by server, collection and path", () => {
  const store = new DraftRecovery(localStorage, "https://connect.test");
  checkpoint(store, "one", "note.md");
  expect(new DraftRecovery(localStorage, "https://connect.test").read("one", "note.md")).toMatchObject(draft);
  expect(store.read("two", "note.md")).toBeUndefined();
  expect(store.read("one", "other.md")).toBeUndefined();
  expect(new DraftRecovery(localStorage, "https://other.test").read("one", "note.md")).toBeUndefined();
  store.remove("one", "note.md");
  expect(store.read("one", "note.md")).toBeUndefined();
});

it("expires recovery copies after seven days and clears malformed copies", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const store = new DraftRecovery(localStorage, "server");
  checkpoint(store, "one", "note.md");
  now.mockReturnValue(1_001 + DRAFT_RETENTION_MS);
  expect(new DraftRecovery(localStorage, "server").read("one", "note.md")).toBeUndefined();
  expect(localStorage.length).toBe(0);
  checkpoint(store, "one", "note.md");
  localStorage.setItem(localStorage.key(0)!, "not json");
  expect(store.read("one", "note.md")).toBeUndefined();
  now.mockRestore();
});

it("keeps an unconfirmed checkpoint past ordinary draft expiry and through an optimistic read", () => {
  const store = new DraftRecovery(localStorage, "server");
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  store.write("one", "note.md", { ...draft, awaitingSync: true }, ignored);
  store.flush();
  now.mockReturnValue(1001 + DRAFT_RETENTION_MS);
  const saved = { body: draft.body, frontmatter: { title: "New" } };
  expect(store.read("one", "note.md", { ...saved, pendingSync: true })).toMatchObject(draft);
  expect(store.read("one", "note.md", saved)).toBeUndefined();
  now.mockRestore();
});

it("does not hide storage failures or confuse deletions with unchanged properties", () => {
  const store = new DraftRecovery(localStorage, "server");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  const stored = vi.fn();
  store.write("one", "note.md", draft, stored);
  store.flush();
  expect(stored).toHaveBeenCalledExactlyOnceWith(false);
  write.mockRestore();
  store.write("one", "note.md", draft, stored);
  store.flush();
  expect(stored).toHaveBeenLastCalledWith(true);
  expect(frontmatterPatch({ title: "Old", tags: ["x"] }, { title: "New" })).toEqual({ title: "New", tags: null });
});

it("retires already-saved checkpoints but preserves unsaved properties and another tab's newer text", () => {
  const store = new DraftRecovery(localStorage, "server");
  const saved = { body: draft.body, frontmatter: { title: "New" } };
  checkpoint(store, "one", "note.md");
  expect(store.read("one", "note.md", saved)).toBeUndefined();
  expect(store.read("one", "note.md")).toBeUndefined();
  checkpoint(store, "one", "note.md");
  expect(store.read("one", "note.md", { ...saved, frontmatter: { title: "Old" } })).toMatchObject(draft);
  checkpoint(store, "one", "note.md", { ...draft, body: "Other tab's unsaved writing" });
  store.remove("one", "note.md", saved);
  expect(store.read("one", "note.md")?.body).toBe("Other tab's unsaved writing");
});

it("forgets every checkpoint of one collection on one server only", () => {
  const store = new DraftRecovery(localStorage, "server");
  checkpoint(store, "private", "a.md");
  checkpoint(store, "private", "nested/b.md");
  checkpoint(store, "other", "a.md");
  const elsewhere = new DraftRecovery(localStorage, "other-server");
  checkpoint(elsewhere, "private", "a.md");
  store.forgetCollection("private");
  expect(store.read("private", "a.md")).toBeUndefined();
  expect(store.read("private", "nested/b.md")).toBeUndefined();
  expect(store.read("other", "a.md")).toMatchObject(draft);
  expect(elsewhere.read("private", "a.md")).toMatchObject(draft);
});

describe("checkpoints wait for a pause in writing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const stored = () => new DraftRecovery(localStorage, "server").read("one", "note.md");

  it("writes only the latest text, once, after the pause", () => {
    const store = new DraftRecovery(localStorage, "server");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const outcome = vi.fn();
    for (const body of ["U", "Un", "Uns"]) {
      store.write("one", "note.md", { ...draft, body }, outcome);
      vi.advanceTimersByTime(DRAFT_CHECKPOINT_IDLE_MS - 1);
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setItem).toHaveBeenCalledOnce();
    expect(stored()?.body).toBe("Uns");
    expect(outcome).toHaveBeenCalledExactlyOnceWith(true);
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledOnce();
  });

  it("writes every waiting note at once on flush and not again afterwards", () => {
    const store = new DraftRecovery(localStorage, "server");
    store.write("one", "note.md", draft, ignored);
    store.write("one", "other.md", { ...draft, body: "Other" }, ignored);
    store.flush();
    expect(stored()?.body).toBe(draft.body);
    expect(store.read("one", "other.md")?.body).toBe("Other");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    vi.runAllTimers();
    store.flush();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("reports a write that the browser refuses when it happens", () => {
    const store = new DraftRecovery(localStorage, "server");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const outcome = vi.fn();
    store.write("one", "note.md", draft, outcome);
    expect(outcome).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DRAFT_CHECKPOINT_IDLE_MS);
    expect(outcome).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("removes at once and never lets a waiting checkpoint resurrect a saved note", () => {
    const store = new DraftRecovery(localStorage, "server");
    checkpoint(store, "one", "note.md", { ...draft, body: "Earlier" });
    const outcome = vi.fn();
    store.write("one", "note.md", draft, outcome);
    store.remove("one", "note.md", { body: draft.body, frontmatter: { title: "New" } });
    expect(stored()).toBeUndefined();
    vi.runAllTimers();
    store.flush();
    expect(stored()).toBeUndefined();
    expect(outcome).not.toHaveBeenCalled();
  });

  it("drops a reverted note's waiting checkpoint and its older stored copy", () => {
    const store = new DraftRecovery(localStorage, "server");
    checkpoint(store, "one", "note.md", { ...draft, body: "Earlier" });
    store.write("one", "note.md", { ...draft, body: "Discarded" }, ignored);
    store.remove("one", "note.md", { body: "Original", frontmatter: { title: "Old" } });
    vi.runAllTimers();
    expect(stored()).toBeUndefined();
  });

  it("drops a renamed note's waiting checkpoint under its old path", () => {
    const store = new DraftRecovery(localStorage, "server");
    store.write("one", "note.md", draft, ignored);
    store.remove("one", "note.md", { body: draft.body, frontmatter: { title: "New" } });
    store.write("one", "renamed.md", draft, ignored);
    vi.runAllTimers();
    expect(stored()).toBeUndefined();
    expect(store.read("one", "renamed.md")).toMatchObject(draft);
  });

  it("drops a forgotten collection's waiting checkpoints", () => {
    const store = new DraftRecovery(localStorage, "server");
    store.write("private", "a.md", draft, ignored);
    store.write("other", "a.md", draft, ignored);
    store.forgetCollection("private");
    vi.runAllTimers();
    expect(store.read("private", "a.md")).toBeUndefined();
    expect(store.read("other", "a.md")).toMatchObject(draft);
  });

  it("writes waiting checkpoints when the page is hidden, left or unmounted", () => {
    const { result, unmount } = renderHook(() => useDraftRecovery(() => "server", undefined));
    const store = result.current!;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    store.write("one", "note.md", { ...draft, body: "Visible" }, ignored);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stored()).toBeUndefined();
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(stored()?.body).toBe("Visible");

    store.write("one", "note.md", { ...draft, body: "Left" }, ignored);
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()?.body).toBe("Left");

    store.write("one", "note.md", { ...draft, body: "Unmounted" }, ignored);
    unmount();
    expect(stored()?.body).toBe("Unmounted");
    store.write("one", "note.md", { ...draft, body: "After unmount" }, ignored);
    window.dispatchEvent(new Event("pagehide"));
    expect(stored()?.body).toBe("Unmounted");
  });
});
