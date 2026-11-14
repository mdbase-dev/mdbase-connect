// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { commentFromRecord, type CommentPeople, type CommentRecord, type PlacedThread } from "./comments.js";
import { CommentsPanel, type CommentDrafts, type PendingComment } from "./CommentsPanel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const people: CommentPeople = { names: new Map(), me: { link: "[[people/Sam Okafor]]", name: "Sam Okafor" }, signing: { kind: "linked" } };
const comment = (path: string, by: string, at: string) =>
  commentFromRecord(path, { document: "[[chapters/method]]", created_by: by, created_at: at }, "text") as CommentRecord;
const placed = (path: string, record: string, by = "[[people/Jordan Ellis]]"): PlacedThread =>
  ({ thread: { root: comment(path, by, "2026-10-02T10:00:00Z"), replies: [] }, record, at: "whole" });

function show(props: Partial<Parameters<typeof CommentsPanel>[0]>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (more: Partial<Parameters<typeof CommentsPanel>[0]> = {}) => act(() => root.render(
    <CommentsPanel threads={[]} people={people} active={null} pending={null} onSelect={() => {}} onSubmit={async () => ({ ok: true })} onCancel={() => {}} {...props} {...more} />,
  ));
  render();
  return { host, render, unmount: () => act(() => root.unmount()) };
}

const type = (field: HTMLTextAreaElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

afterEach(() => { document.body.innerHTML = ""; });

it("submits a suggested edit as the replacement text, once it differs from the passage", async () => {
  const onSubmit = vi.fn(async () => ({ ok: true as const }));
  const pending: PendingComment = { quote: "suggests strongly", suggest: true, on: "Method" };
  const { host } = show({ pending, onSubmit });
  expect(host.querySelector(".mdbase-comment-composer-title")!.textContent).toBe("Suggest an editas Sam Okafor · Method");
  const [replacement, reason] = [...host.querySelectorAll("textarea")];
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(replacement!.value).toBe("suggests strongly");
  expect(submit.disabled).toBe(true);
  type(replacement!, "suggests");
  type(reason!, "Too strong");
  await act(async () => submit.click());
  expect(onSubmit).toHaveBeenCalledWith("Too strong", "suggests");
});

it("heads each record's threads with its title and marks what others wrote since the last visit", () => {
  const threads = [placed("comments/a.md", "chapters/intro.md"), placed("comments/b.md", "chapters/intro.md", "[[people/Sam Okafor]]"), placed("comments/c.md", "chapters/method.md")];
  const { host } = show({ threads, recordTitle: (record) => record.replace(/^chapters\/|\.md$/g, ""), since: "2026-10-01T00:00:00Z" });
  expect([...host.querySelectorAll(".mdbase-threads > li")].map((row) => row.querySelector("h3")?.textContent ?? row.getAttribute("data-thread")))
    .toEqual(["intro", "comments/a.md", "comments/b.md", "method", "comments/c.md"]);
  expect([...host.querySelectorAll(".mdbase-thread-new")].map((mark) => mark.closest("[data-thread]")!.getAttribute("data-thread"))).toEqual(["comments/a.md", "comments/c.md"]);
});

it("keeps a reply in progress in the app's drafts when the panel is closed and reopened", () => {
  const drafts: CommentDrafts = new Map();
  const threads = [placed("comments/a.md", "chapters/intro.md")];
  const props = { threads, drafts, onReply: async () => ({ ok: true as const }) };
  const first = show(props);
  act(() => [...first.host.querySelectorAll("button")].find((button) => button.textContent === "Reply")!.click());
  type(first.host.querySelector("textarea")!, "Half a thought");
  first.unmount();
  expect(show(props).host.querySelector("textarea")!.value).toBe("Half a thought");
});

it("offers to withdraw the first comment only while no reply to it stands", () => {
  const mine = (path: string, extra: Record<string, unknown> = {}) =>
    commentFromRecord(path, { document: "[[chapters/method]]", created_by: "[[people/Sam Okafor]]", created_at: "2026-10-02T10:00:00Z", ...extra }, extra.deleted_at ? "" : "text") as CommentRecord;
  const thread = (...replies: CommentRecord[]): PlacedThread => ({ thread: { root: mine("comments/a.md"), replies }, record: "chapters/method.md", at: "whole" });
  const live = mine("comments/b.md", { in_reply_to: "[[comments/a]]" });
  const withdrawn = mine("comments/b.md", { in_reply_to: "[[comments/a]]", deleted_at: "2026-10-02T11:00:00Z" });
  const later = mine("comments/c.md", { in_reply_to: "[[comments/a]]", created_at: "2026-10-02T12:00:00Z" });
  const { host, render } = show({ threads: [thread()], onChange: async () => ({ ok: true as const }) });
  const rootWithdraw = () => [...host.querySelectorAll(".mdbase-thread-actions button")].some((button) => button.textContent === "Withdraw");

  expect(rootWithdraw()).toBe(true);
  render({ threads: [thread(live)] });
  expect(rootWithdraw()).toBe(false);
  render({ threads: [thread(withdrawn)] });
  expect(rootWithdraw()).toBe(true);
  expect(host.querySelector(".mdbase-comment.is-reply .mdbase-comment-withdrawn")!.textContent).toBe("Withdrawn.");
  render({ threads: [thread(withdrawn, later)] });
  expect(rootWithdraw()).toBe(false);
});
