import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/cbor.js";
import { queryMetadata, queryResult, queryUpdate } from "../src/wire.js";

// Native wire codec conformance vectors.
// They do not prove runtime execution of query groups or summaries.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/native-${name}.cbor`, import.meta.url)));

describe("native query metadata wire contract", () => {
  for (const name of ["query-result-metadata", "query-result-limit-zero"] as const) {
    it(`preserves exact native ${name} bytes`, () => {
      const bytes = fixture(name);
      const result = queryResult.dec(decode(bytes));
      expect(encode(queryResult.enc(result))).toEqual(bytes);
      expect(result.totalCount).toBe(12);
      expect(result.hasMore).toBe(true);
      expect(result.groups?.[0]?.count).toBe(12);
      if (name === "query-result-limit-zero") expect(result.records).toEqual([]);
      else {
        expect(result.columns).toEqual(["label"]);
        expect(result.records[0]?.values?.get("label")).toBe("Done");
        expect(result.groups?.[0]?.values.get("status")).toBe("done");
        expect(result.groups?.[0]?.summaries?.get("total_estimate")).toBe(30);
      }
    });
  }
  it("preserves full live metadata at the same enclosing asOf", () => {
    const bytes = fixture("query-update-metadata");
    const update = queryUpdate.dec(decode(bytes));
    expect(encode(queryUpdate.enc(update))).toEqual(bytes);
    expect(update.asOf).toBe(100);
    expect(update.metadata?.groups?.[0]?.count).toBe(12);
    expect(update.metadata?.hasMore).toBe(true);
  });
  it("legacy omissions stay absent, not fabricated empty groups/counts", () => {
    const result = queryResult.dec(queryResult.enc({ records: [], complete: true, asOf: 1 }));
    expect(result).toEqual({ records: [], complete: true, asOf: 1 });
    const update = queryUpdate.dec(queryUpdate.enc({ sub: 1, kind: "diff", complete: true, asOf: 2 }));
    expect(update).not.toHaveProperty("metadata");
    expect(queryMetadata.dec(queryMetadata.enc({}))).toEqual({});
  });
  it("preserves explicit false/zero/empty metadata", () => {
    const metadata = { columns: [], totalCount: 0, groups: [], hasMore: false };
    expect(queryMetadata.dec(queryMetadata.enc(metadata))).toEqual(metadata);
  });
});
