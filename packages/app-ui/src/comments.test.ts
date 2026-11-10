import { describe, expect, it } from "vitest";

import {
  applySuggestion,
  bodyHash,
  codePointOffset,
  commentFromRecord,
  commentThreads,
  linkPath,
  locate,
  recordLink,
  changeFields,
  editorTarget,
  newCommentFields,
  personName,
  RecordPaths,
  targetFor,
  placeThreads,
  recordThreads,
  utf16Offset,
  threadIsNew,
  writtenByMe,
  type CommentRecord,
} from "./comments.js";

const body = "# Method\n\nThe evidence suggests strongly that it works. Later, the evidence suggests strongly otherwise.\n";
const hash = `sha256:${"0".repeat(64)}`;
const second = body.lastIndexOf("suggests strongly");

describe("offsets", () => {
  it("counts code points, not UTF-16 units", () => {
    const text = "a😀b";
    expect(codePointOffset(text, 3)).toBe(2);
    expect(utf16Offset(text, 2)).toBe(3);
    expect(utf16Offset(text, 99)).toBe(text.length);
  });

  it("hashes the UTF-8 body", async () => {
    expect(await bodyHash("")).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("locate", () => {
  const target = targetFor(body, second, second + "suggests strongly".length, hash);

  it("uses the recorded position while the quote is there", () => {
    expect(locate(body, target)).toEqual({ from: second, to: second + 17 });
  });

  it("follows the quote when text before it changes", () => {
    const edited = `Preface.\n\n${body}`;
    const at = locate(edited, target);
    expect(at).toEqual({ from: second + 10, to: second + 27 });
  });

  it("tells repeated quotes apart by their surroundings, not the nearest one", () => {
    // The recorded position now points at the first occurrence's surroundings.
    const edited = body.replace("# Method\n\n", "");
    expect(locate(edited, { quote: target.quote, text_position: { ...target.text_position!, start: 0, end: 0 } })).toEqual({
      from: edited.lastIndexOf("suggests strongly"),
      to: edited.lastIndexOf("suggests strongly") + 17,
    });
  });

  it("detaches a thread whose quote was deleted", () => {
    expect(locate(body.replaceAll("suggests strongly", "shows"), target)).toBeNull();
  });

  it("finds a quote without a recorded position", () => {
    expect(locate(body, { quote: { exact: "it works" } })).toEqual({ from: body.indexOf("it works"), to: body.indexOf("it works") + 8 });
  });

  it("finds an insertion point by the text either side", () => {
    const at = body.indexOf(" that it");
    const point = targetFor(body, at, at, hash);
    expect(point.quote.exact).toBe("");
    expect(locate(`Preface. ${body}`, point)).toEqual({ from: at + 9, to: at + 9 });
    expect(locate(body.replace(" that it", " so it"), point)).toBeNull();
  });

  it("measures positions in code points", () => {
    const text = "😀 mark this";
    const t = targetFor(text, 3, 7, hash);
    expect(t.text_position).toMatchObject({ start: 2, end: 6 });
    expect(locate(text, t)).toEqual({ from: 3, to: 7 });
  });
});

describe("suggestions", () => {
  it("replaces the located quote", () => {
    const target = targetFor(body, second, second + 17, hash);
    expect(applySuggestion(body, target, "suggests")).toBe(body.slice(0, second) + "suggests" + body.slice(second + 17));
  });

  it("deletes with an empty replacement and inserts at a point", () => {
    const start = body.indexOf(" strongly");
    expect(applySuggestion(body, targetFor(body, start, start + 9, hash), "")).toContain("The evidence suggests that");
    const point = body.indexOf(" that it");
    expect(applySuggestion(body, targetFor(body, point, point, hash), ", clearly,")).toContain("suggests strongly, clearly, that it");
  });

  it("refuses when the quote is gone", () => {
    expect(applySuggestion("Nothing here.", { quote: { exact: "suggests" } }, "shows")).toBeNull();
  });
});

describe("records and threads", () => {
  const record = (path: string, fields: Record<string, unknown>, text = "") =>
    commentFromRecord(path, { document: "[[chapters/method]]", created_at: "2026-09-29T10:00:00Z", ...fields }, text) as CommentRecord;

  it("reads the contract's fields", () => {
    const c = record("comments/a.md", {
      motivation: "editing",
      target: { quote: { exact: "x", prefix: "a " }, text_position: { basis: { profile: "markdown-body", hash }, unit: "unicode_code_point", start: 2, end: 3 } },
      suggestion: { replacement: "y" },
      created_by: "[[Alex Rivera]]",
    }, "\nToo strong?\n");
    expect(c).toMatchObject({ motivation: "editing", status: "open", suggestion: { replacement: "y" }, createdBy: "[[Alex Rivera]]", text: "Too strong?" });
    expect(c.target?.text_position?.start).toBe(2);
  });

  it("rejects records without a document or creation time", () => {
    expect(commentFromRecord("c.md", { created_at: "2026-09-29T10:00:00Z" }, "")).toBeNull();
    expect(commentFromRecord("c.md", { document: "[[a]]" }, "")).toBeNull();
  });

  it("groups replies under their thread, oldest first", () => {
    const root = record("comments/root.md", {});
    const late = record("comments/late.md", { in_reply_to: "[[comments/root]]", created_at: "2026-09-29T12:00:00Z" });
    const early = record("comments/early.md", { in_reply_to: "[[comments/root|the thread]]", created_at: "2026-09-29T11:00:00Z" });
    const stray = record("comments/stray.md", { in_reply_to: "[[comments/deleted]]", created_at: "2026-09-29T09:00:00Z" });
    const threads = commentThreads([late, root, early, stray]);
    expect(threads.map((t) => t.root.path)).toEqual(["comments/stray.md", "comments/root.md"]);
    expect(threads[1]?.replies.map((r) => r.path)).toEqual(["comments/early.md", "comments/late.md"]);
  });

  it("links records by path without the extension", () => {
    expect(recordLink("chapters/method.md")).toBe("[[chapters/method]]");
    expect(linkPath("[[chapters/method|Method]]")).toBe("chapters/method");
    expect(linkPath("[[chapters/method#Results]]")).toBe("chapters/method");
  });
});

describe("the threads on a record", () => {
  const paths = new RecordPaths(["chapters/method.md", "chapters/results.md", "notes/Method.md", "comments/a.md", "comments/b.md", "comments/c.md", "comments/d.md"]);
  const comment = (path: string, fields: Record<string, unknown>, text = "said") =>
    commentFromRecord(path, { document: "[[chapters/method]]", created_at: "2026-09-29T10:00:00Z", ...fields }, text) as CommentRecord;

  it("follows exact, relative and unique file-name links", () => {
    expect(paths.resolve("[[chapters/method]]", "comments/a.md")).toBe("chapters/method.md");
    expect(paths.resolve("[[../chapters/results.md]]", "comments/a.md")).toBe("chapters/results.md");
    expect(paths.resolve("[[results]]", "comments/a.md")).toBe("chapters/results.md");
    // Two records are called Method, so the bare name leads nowhere.
    expect(paths.resolve("[[method]]", "comments/a.md")).toBeNull();
    expect(paths.resolve("[[chapters/missing]]", "comments/a.md")).toBeNull();
  });

  it("orders whole-record threads, then by position, then detached ones", () => {
    const placed = placeThreads(recordThreads("chapters/method.md", [
      comment("comments/a.md", { target: { quote: { exact: "no longer here" } } }),
      comment("comments/b.md", { target: { quote: { exact: "otherwise" } } }),
      comment("comments/c.md", {}),
      comment("comments/d.md", { document: "[[chapters/results]]" }),
    ], paths), body);
    expect(placed.map((p) => [p.thread.root.path, p.at === "whole" || p.at === null ? p.at : "placed"])).toEqual([
      ["comments/c.md", "whole"],
      ["comments/b.md", "placed"],
      ["comments/a.md", null],
    ]);
  });

  it("hides a withdrawn comment nobody replied to", () => {
    const withdrawn = comment("comments/a.md", { deleted_at: "2026-09-30T10:00:00Z" }, "");
    expect(recordThreads("chapters/method.md", [withdrawn], paths)).toEqual([]);
    const reply = comment("comments/b.md", { in_reply_to: "[[comments/a]]" });
    expect(recordThreads("chapters/method.md", [withdrawn, reply], paths)).toHaveLength(1);
  });

  it("finds a quote stored with CRLF line breaks in an editor's LF text", () => {
    const stored = "One line.\r\nAnother line.\r\n";
    const from = stored.indexOf("line.\r\nAnother");
    const target = targetFor(stored, from, from + 14, hash);
    expect(locate("One line.\nAnother line.\n", editorTarget(target))).toEqual({ from: 4, to: 17 });
    const plain = targetFor(body, 0, 8, hash);
    expect(editorTarget(plain)).toBe(plain);
  });
});

describe("writing comments", () => {
  const now = new Date("2026-10-01T08:00:00Z");
  const root = commentFromRecord("comments/root.md", { document: "[[chapters/method]]", created_at: "2026-09-29T10:00:00Z", motivation: "editing", suggestion: { replacement: "y" }, created_by: "[[people/Sam Okafor]]" }, "") as CommentRecord;

  it("starts a thread with its anchor and state, and a reply with neither", () => {
    const target = targetFor(body, 0, 8, hash);
    expect(newCommentFields({ document: "chapters/method.md", target }, now, "[[people/Sam Okafor]]")).toEqual({
      document: "[[chapters/method]]", motivation: "commenting", target, status: "open", created_by: "[[people/Sam Okafor]]", created_at: "2026-10-01T08:00:00.000Z",
    });
    expect(newCommentFields({ document: "chapters/method.md", target, thread: root }, now, undefined)).toEqual({
      document: "[[chapters/method]]", in_reply_to: "[[comments/root]]", motivation: "replying", created_at: "2026-10-01T08:00:00.000Z",
    });
  });

  it("records who resolved a thread and what became of its suggestion", () => {
    expect(changeFields(root, { kind: "resolve", outcome: "accepted" }, now, "[[people/Jordan Ellis]]").fields).toMatchObject({
      status: "resolved", resolved_by: "[[people/Jordan Ellis]]", suggestion: { replacement: "y", outcome: "accepted" },
    });
    expect(changeFields(root, { kind: "withdraw" }, now, undefined)).toMatchObject({ body: "", fields: { deleted_at: "2026-10-01T08:00:00.000Z" } });
  });

  it("names authors from their person records", () => {
    const people = { names: new Map([["people/sam okafor", "Sam Okafor"]]), me: { link: "[[people/Sam Okafor]]", name: "Sam Okafor" } };
    expect(personName("[[people/Sam Okafor]]", people)).toBe("Sam Okafor");
    expect(personName("[[Sam Okafor]]", people)).toBe("Sam Okafor");
    expect(personName("[[people/someone|Someone Else]]", people)).toBe("Someone Else");
    expect(writtenByMe(root, people)).toBe(true);
    expect(writtenByMe(root, { names: new Map() })).toBe(false);
  });

  it("marks a thread new when someone else has written in it since the last visit", () => {
    const people = { names: new Map(), me: { link: "[[people/Sam Okafor]]", name: "Sam Okafor" } };
    const comment = (path: string, by: string, at: string, more: Record<string, unknown> = {}) =>
      commentFromRecord(path, { document: "[[chapters/method]]", created_by: by, created_at: at, ...more }, "text") as CommentRecord;
    const mine = comment("comments/a.md", "[[people/Sam Okafor]]", "2026-10-02T09:00:00Z");
    const theirs = comment("comments/b.md", "[[people/Jordan Ellis]]", "2026-10-02T10:00:00Z");
    const since = "2026-10-01T00:00:00Z";
    expect(threadIsNew({ root: mine, replies: [] }, since, people)).toBe(false);
    expect(threadIsNew({ root: mine, replies: [theirs] }, since, people)).toBe(true);
    expect(threadIsNew({ root: mine, replies: [theirs] }, "2026-10-03T00:00:00Z", people)).toBe(false);
    expect(threadIsNew({ root: mine, replies: [{ ...theirs, deletedAt: "2026-10-02T11:00:00Z" }] }, since, people)).toBe(false);
    expect(threadIsNew({ root: theirs, replies: [] }, undefined, people)).toBe(false);
  });
});
