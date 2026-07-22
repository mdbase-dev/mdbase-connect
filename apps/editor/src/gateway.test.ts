import { describe, expect, it, vi } from "vitest";
import { ConnectCollectionGateway } from "./gateway";
import type { NoteListProgress, NoteSummary } from "./model";

describe("ConnectCollectionGateway collection index", () => {
  it("loads the complete structure before hydrating note bodies", async () => {
    const metadata = [summary("Notes/one.md"), summary("Archive/two.md")];
    const hydrated = metadata.map((note, index) => ({ ...note, body: `Body ${index + 1}` }));
    const query = vi.fn(async ({ include_body: includeBody, offset }: { include_body: boolean; offset: number; snapshot?: string }) => {
      const page = includeBody ? hydrated[offset] : metadata[offset];
      return {
        valid: true,
        diagnostics: [],
        result: {
          results: page ? [page] : [],
          meta: { total_count: 2, has_more: offset === 0, snapshot: "stable-index" }
        }
      };
    });
    const gateway = Object.create(ConnectCollectionGateway.prototype) as ConnectCollectionGateway;
    Object.defineProperty(gateway, "connect", { value: { query } });
    const progress: NoteListProgress[] = [];

    const notes = await gateway.list((update) => progress.push(update));

    expect(query.mock.calls.map(([input]) => [input.include_body, input.offset])).toEqual([
      [false, 0],
      [false, 1],
      [true, 0],
      [true, 1]
    ]);
    expect(query.mock.calls.map(([input]) => input.snapshot)).toEqual([
      undefined,
      "stable-index",
      "stable-index",
      "stable-index"
    ]);
    expect(progress[0]).toMatchObject({ structureComplete: false, complete: false, total: 2 });
    expect(progress[0].notes[0].body).toBeUndefined();
    expect(progress[1]).toMatchObject({ structureComplete: true, complete: false, total: 2 });
    expect(progress[1].notes.map((note) => note.path)).toEqual(["Notes/one.md", "Archive/two.md"]);
    expect(progress.at(-1)).toMatchObject({ structureComplete: true, complete: true, total: 2 });
    expect(notes.map((note) => note.body)).toEqual(["Body 1", "Body 2"]);
  });
});

function summary(path: string): NoteSummary {
  return { path, frontmatter: {}, types: [] };
}
