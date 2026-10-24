import {describe, expect, it, vi} from "vitest";
import {MdbaseError} from "../src/errors.js";
import {executeSavedView, listSavedViews} from "../src/saved-views.js";
import {toValue} from "../src/values.js";
import type {CborValue} from "../src/cbor.js";

const ID = "018f0000-0000-7000-8000-000000000001";
const REV = "sha256:" + "ab".repeat(32);
const fields = toValue({
  id: "reader.library", name: "Library",
  query: {types: ["source"], where: "status != 'archived'", projections: {age: {expr: "today() - added"}}, context: {this: {on_missing: "null"}}},
  properties: {title: {label: "Title"}},
  views: [{id: "recent", name: "Recent", where: "added > today() - 7", select: ["title", "projection.age"], order_by: [{field: "added", direction: "desc"}], limit: 20, presentation: {type: "reader.list"}}],
}) as Map<string, CborValue>;
const record = {id: ID, path: "Views/library.md", revision: REV, frontmatter: new Map(), types: ["view"], state: {state: "confirmed", confirmedSeq: 1}};

function client() {
  return {
    queryContract: vi.fn(async () => ({version: 1, contractDigest: "d", page: {records: [record], complete: true, asOf: 1}, records: [{id: ID, implementations: [{typeName: "view", fields, issues: []}]}]})),
    getContract: vi.fn(async () => ({id: ID, path: record.path, revision: REV, fields, contract: {id: "mdbase.view", version: "1.0.0", digest: "d", type: "view", implementationDigest: "i"}})),
    get: vi.fn(),
    query: vi.fn(async () => ({records: [], complete: true, asOf: 1})),
  };
}

describe("saved views over served native methods", () => {
  it("lists mdbase.view sources and executes a named view as one spec 11 query", async () => {
    const c = client();
    const listed = await listSavedViews(c as never);
    expect(listed.sources).toEqual([expect.objectContaining({record: ID, id: "reader.library", name: "Library", source: {path: "Views/library.md", format: "mdbase.view", revision: REV, writable: true}})]);
    expect(listed.sources[0]!.views[0]).toMatchObject({id: "recent", name: "Recent", properties: [{key: "title", label: "Title"}, {key: "age"}]});

    const result = await executeSavedView(c as never, {path: record.path}, "recent", {limit: 5, timezone: "UTC"});
    expect(result.view).toEqual({path: record.path, view: "recent"});
    const [query] = c.query.mock.calls[0] as unknown as [Map<string, CborValue>];
    expect(Object.fromEntries(query)).toEqual({
      types: ["source"],
      where: "(status != 'archived') && (added > today() - 7)",
      projections: new Map([["age", new Map([["expr", "today() - added"]])]]),
      select: ["title", "projection.age"],
      order_by: [new Map([["field", "added"], ["direction", "desc"]])],
      limit: 5,
      timezone: "UTC",
    });
    expect(c.get).not.toHaveBeenCalled();
  });

  it("a collection without the contract has no views; an unknown view is view_not_found", async () => {
    const c = client();
    c.queryContract.mockRejectedValueOnce(new MdbaseError({code: "not_found", recovery: "refresh", message: "x", reason: "data_contract_not_found"}));
    expect(await listSavedViews(c as never)).toEqual({sources: [], diagnostics: [], complete: true});
    await expect(executeSavedView(c as never, {path: record.path}, "missing")).rejects.toMatchObject({code: "not_found", reason: "view_not_found"});
  });
});
