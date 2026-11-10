import type { CollectionContractImplementationDescriptor, CollectionDescription } from "@mdbase-dev/connect";
import { RecordPaths, placeThreads, recordThreads } from "@mdbase-dev/ui/comments";
import { describe, expect, it } from "vitest";
import type { NoteSummary } from "./model";
import { collectionComments, commentImplementations, commentPeople, contractFields, localFields, storedOffset } from "./note-comments";

const implementation = (fields: Record<string, string>, typeName = "comment"): CollectionContractImplementationDescriptor =>
  ({ typeName, typeVersion: 1, digest: "sha256:0", fields });
const direct = implementation({ document: "document", in_reply_to: "in_reply_to", motivation: "motivation", target: "target", status: "status", created_at: "created_at", created_by: "created_by", deleted_at: "deleted_at" });
const renamed = implementation({ "/document": "about", "/status": "state", "/created_at": "meta.at" }, "remark");

const note = (path: string, types: string[], frontmatter: NoteSummary["frontmatter"], body?: string): NoteSummary =>
  ({ path, body, types, frontmatter, effectiveFrontmatter: frontmatter, revision: "r1", file: { path, name: path, folder: "", size: 0, mtime: "" } });

describe("note comments", () => {
  it("finds the types that implement this version of the comment contract", () => {
    const description = { contracts: [
      { contractType: "record", id: "mdbase.comment", version: "1.0.0", implementations: [direct] },
      { contractType: "record", id: "mdbase.person", version: "1.0.0", implementations: [implementation({}, "person")] },
    ] } as unknown as CollectionDescription;
    expect(commentImplementations(description).map((found) => found.typeName)).toEqual(["comment"]);
    expect(commentImplementations(undefined)).toEqual([]);
  });

  it("reads and writes a type's own field names, keeping the rest of a nested field", () => {
    expect(contractFields({ about: "[[notes/a]]", state: "open", meta: { at: "2026-11-10T00:00:00Z", by: "x" }, other: 1 }, renamed))
      .toEqual({ document: "[[notes/a]]", status: "open", created_at: "2026-11-10T00:00:00Z" });
    expect(localFields({ status: "resolved", created_at: "2026-11-11T00:00:00Z" }, renamed, { meta: { at: "old", by: "x" } }))
      .toEqual({ state: "resolved", meta: { at: "2026-11-11T00:00:00Z", by: "x" } });
  });

  it("threads the open note's comments from the index and leaves other records alone", () => {
    const notes = [
      note("notes/a.md", ["note"], {}, "One two three."),
      note("comments/1.md", ["comment"], { document: "[[notes/a]]", motivation: "commenting", status: "open", created_at: "2026-11-10T00:00:00Z", target: { quote: { exact: "two" } } }, "First"),
      note("comments/2.md", ["comment"], { document: "[[notes/a]]", in_reply_to: "[[comments/1]]", motivation: "replying", status: "open", created_at: "2026-11-10T01:00:00Z" }),
      note("comments/3.md", ["comment"], { document: "[[notes/b]]", motivation: "commenting", status: "open", created_at: "2026-11-10T02:00:00Z" }, "Elsewhere"),
      note("notes/looks-like.md", ["note"], { document: "[[notes/a]]", status: "open", created_at: "2026-11-10T00:00:00Z" }, "Not a comment"),
    ];
    const comments = collectionComments(notes, [direct], new Map([["comments/2.md", "Read later"]]));
    expect(comments.map((comment) => comment.path)).toEqual(["comments/1.md", "comments/2.md", "comments/3.md"]);
    const threads = recordThreads("notes/a.md", comments, new RecordPaths(notes.map((each) => each.path)));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.replies.map((reply) => reply.text)).toEqual(["Read later"]);
    expect(placeThreads(threads, "One two three.")[0]!.at).toEqual({ from: 4, to: 7 });
  });

  it("signs only for an account that resolves to exactly one valid person", () => {
    const people = [{ path: "people/ada.md", name: "Ada" }];
    expect(commentPeople({ me: { status: "linked", person: people[0] }, people } as never))
      .toMatchObject({ me: { link: "[[people/ada]]", name: "Ada" }, signing: { kind: "linked" } });
    expect(commentPeople({ me: { status: "unlinked" }, people } as never).me).toBeUndefined();
    expect(commentPeople({ me: { status: "ambiguous", paths: ["people/a.md", "people/b.md"] }, people } as never))
      .toMatchObject({ signing: { kind: "conflict", paths: ["people/a.md", "people/b.md"] } });
  });

  it("maps the editor's offsets onto a body that keeps Windows line breaks", () => {
    expect(storedOffset("a\nb", 2)).toBe(2);
    expect(storedOffset("a\r\nb\r\nc", 2)).toBe(3);
    expect(storedOffset("a\r\nb\r\nc", 4)).toBe(6);
  });
});
