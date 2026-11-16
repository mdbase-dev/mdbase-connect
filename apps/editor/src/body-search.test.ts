import { describe, expect, it, vi } from "vitest";
import { BodySearch, bodySearchTerms, bodySearchWhere, EXCERPT_READS } from "./body-search";
import type { CollectionGateway, NoteDocument, NoteSummary } from "./model";

type Gateway = Pick<CollectionGateway, "searchBodies" | "read">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function note(path: string, revision = "r1", body?: string): NoteSummary {
  return { path, revision, frontmatter: {}, effectiveFrontmatter: {}, types: [], ...(body === undefined ? {} : { body }) } as unknown as NoteSummary;
}

/** A gateway whose answers are settled by the test, one call at a time. */
function manualGateway() {
  const searches: Array<{ term: string; signal?: AbortSignal; answer: ReturnType<typeof deferred<string[]>> }> = [];
  const reads: string[] = [];
  const gateway: Gateway = {
    searchBodies: (term, options) => {
      const answer = deferred<string[]>();
      searches.push({ term, signal: options?.signal, answer });
      return answer.promise;
    },
    read: async (path) => {
      reads.push(path);
      return { path, revision: "r1", body: `text of ${path}` } as NoteDocument;
    }
  };
  return { gateway, searches, reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("body search terms", () => {
  it("lower-cases words of three or more characters, once each", () => {
    expect(bodySearchTerms("  Launch ON the LAUNCH  pad ")).toEqual(["launch", "the", "pad"]);
    expect(bodySearchTerms("a b")).toEqual([]);
    // Characters, not UTF-16 units, count toward the minimum.
    expect(bodySearchTerms("😀😀 日本語")).toEqual(["日本語"]);
  });

  it("asks a quoted phrase whole and leaves tag and type filters out", () => {
    expect(bodySearchTerms('"Ordinary   Markdown" #notes tag:x type:note plain')).toEqual(["ordinary markdown", "plain"]);
  });

  it("quotes the term as a CEL string literal", () => {
    expect(bodySearchWhere('say "hi"\\')).toBe('file.body.lower().contains("say \\"hi\\"\\\\")');
  });
});

describe("BodySearch", () => {
  it("asks once typing pauses, once per term, and keeps answers for the revision", async () => {
    const { gateway, searches } = manualGateway();
    const search = new BodySearch(gateway, 0);
    const listener = vi.fn();
    search.subscribe(listener);

    search.search(["lau"], 1);
    search.search(["launch", "plan"], 1);
    expect(search.getSnapshot().pending).toBe(true);
    await settle();
    expect(searches.map((call) => call.term)).toEqual(["launch", "plan"]);
    searches[0].answer.resolve(["A.md"]);
    await settle();
    expect(search.paths("launch")).toEqual(new Set(["A.md"]));
    expect(search.paths("plan")).toBeUndefined();
    expect(search.getSnapshot().pending).toBe(true);
    searches[1].answer.resolve([]);
    await settle();
    expect(search.getSnapshot()).toMatchObject({ pending: false, version: 2 });
    expect(listener).toHaveBeenCalled();

    // The same terms at the same revision are already answered.
    search.search(["plan", "launch"], 1);
    await settle();
    expect(searches).toHaveLength(2);
  });

  it("shows an earlier revision's answer while asking again", async () => {
    const { gateway, searches } = manualGateway();
    const search = new BodySearch(gateway, 0);
    search.search(["launch"], 1);
    await settle();
    searches[0].answer.resolve(["old.md"]);
    await settle();

    search.search(["launch"], 2);
    expect(search.paths("launch")).toEqual(new Set(["old.md"]));
    expect(search.getSnapshot().pending).toBe(false);
    await settle();
    expect(searches).toHaveLength(2);
    // A further change while that runs asks again once it answers.
    search.search(["launch"], 3);
    await settle();
    expect(searches).toHaveLength(2);
    searches[1].answer.resolve(["mid.md"]);
    await settle();
    expect(search.paths("launch")).toEqual(new Set(["mid.md"]));
    await settle();
    expect(searches).toHaveLength(3);
    searches[2].answer.resolve(["new.md"]);
    await settle();
    await settle();
    expect(search.paths("launch")).toEqual(new Set(["new.md"]));
    expect(searches).toHaveLength(3);
  });

  it("aborts and forgets terms the search no longer has", async () => {
    const { gateway, searches } = manualGateway();
    const search = new BodySearch(gateway, 0);
    search.search(["launch", "plan"], 1);
    await settle();
    searches[1].answer.resolve(["A.md"]);
    await settle();
    search.search(["launch"], 1);
    expect(searches[0].signal?.aborted).toBe(false);
    expect(search.paths("plan")).toBeUndefined();
    search.search(["lunch"], 1);
    expect(searches[0].signal?.aborted).toBe(true);
    searches[0].answer.resolve(["A.md"]);
    await settle();
    expect(search.paths("launch")).toBeUndefined();
  });

  it("stops on a failure until retried, then asks every unanswered term", async () => {
    const { gateway, searches } = manualGateway();
    const search = new BodySearch(gateway, 0);
    search.search(["launch", "plan"], 1);
    await settle();
    const failure = new Error("unavailable");
    searches[0].answer.reject(failure);
    await settle();
    expect(searches[1].signal?.aborted).toBe(true);
    expect(search.getSnapshot()).toMatchObject({ pending: false, error: failure });

    // Typing more does not ask while the failure stands.
    search.search(["launch", "plan", "pad"], 1);
    await settle();
    expect(searches).toHaveLength(2);

    search.retry();
    expect(search.getSnapshot().error).toBeUndefined();
    expect(searches.slice(2).map((call) => call.term)).toEqual(["launch", "plan", "pad"]);
    for (const call of searches.slice(2)) call.answer.resolve(["A.md"]);
    await settle();
    expect(search.getSnapshot().pending).toBe(false);
  });

  it("reads excerpt text for leading matches the page lacks, at their revision", async () => {
    const { gateway, reads } = manualGateway();
    const search = new BodySearch(gateway, 0);
    const many = Array.from({ length: EXCERPT_READS + 5 }, (_, index) => note(`N${index}.md`));
    search.readTexts([note("held.md", "r1", "already here"), ...many]);
    await settle();
    expect(reads).not.toContain("held.md");
    expect(reads).toHaveLength(EXCERPT_READS - 1);
    expect(search.text(note("N0.md"))).toBe("text of N0.md");
    // A changed note's old text is not shown for it.
    expect(search.text(note("N0.md", "r2"))).toBeUndefined();

    search.readTexts(many);
    await settle();
    expect(reads).toHaveLength(EXCERPT_READS);
  });

  it("forgets everything on reset", async () => {
    const { gateway, searches } = manualGateway();
    const search = new BodySearch(gateway, 0);
    search.search(["launch"], 1);
    search.readTexts([note("A.md")]);
    await settle();
    search.reset();
    expect(searches[0].signal?.aborted).toBe(true);
    expect(search.text(note("A.md"))).toBeUndefined();
    expect(search.getSnapshot().pending).toBe(false);
  });
});
