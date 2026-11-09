import { expect, it, vi } from "vitest";
import { DraftRecovery, DRAFT_RETENTION_MS, frontmatterPatch } from "./draft-recovery";

const draft = { body: "Unsent text", baseBody: "Original", patch: { title: "New" }, baseFrontmatter: { title: "Old" } };

it("keeps unsent content across reloads, isolated by server, collection and path", () => {
  const store = new DraftRecovery(localStorage, "https://connect.test");
  store.write("one", "note.md", draft);
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
  store.write("one", "note.md", draft);
  now.mockReturnValue(1_001 + DRAFT_RETENTION_MS);
  expect(new DraftRecovery(localStorage, "server").read("one", "note.md")).toBeUndefined();
  expect(localStorage.length).toBe(0);
  store.write("one", "note.md", draft);
  localStorage.setItem(localStorage.key(0)!, "not json");
  expect(store.read("one", "note.md")).toBeUndefined();
  now.mockRestore();
});

it("does not hide storage failures or confuse deletions with unchanged properties", () => {
  const store = new DraftRecovery(localStorage, "server");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  expect(() => store.write("one", "note.md", draft)).toThrow("Full");
  write.mockRestore();
  expect(frontmatterPatch({ title: "Old", tags: ["x"] }, { title: "New" })).toEqual({ title: "New", tags: null });
});

it("retires already-saved checkpoints but preserves unsaved properties and another tab's newer text", () => {
  const store = new DraftRecovery(localStorage, "server");
  const saved = { body: draft.body, frontmatter: { title: "New" } };
  store.write("one", "note.md", draft);
  expect(store.read("one", "note.md", saved)).toBeUndefined();
  expect(store.read("one", "note.md")).toBeUndefined();
  store.write("one", "note.md", draft);
  expect(store.read("one", "note.md", { ...saved, frontmatter: { title: "Old" } })).toMatchObject(draft);
  store.write("one", "note.md", { ...draft, body: "Other tab's unsaved writing" });
  store.remove("one", "note.md", saved);
  expect(store.read("one", "note.md")?.body).toBe("Other tab's unsaved writing");
});

it("forgets every checkpoint of one collection on one server only", () => {
  const store = new DraftRecovery(localStorage, "server");
  store.write("private", "a.md", draft);
  store.write("private", "nested/b.md", draft);
  store.write("other", "a.md", draft);
  const elsewhere = new DraftRecovery(localStorage, "other-server");
  elsewhere.write("private", "a.md", draft);
  store.forgetCollection("private");
  expect(store.read("private", "a.md")).toBeUndefined();
  expect(store.read("private", "nested/b.md")).toBeUndefined();
  expect(store.read("other", "a.md")).toMatchObject(draft);
  expect(elsewhere.read("private", "a.md")).toMatchObject(draft);
});
