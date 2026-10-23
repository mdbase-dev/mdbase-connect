import { describe, expect, it, vi } from "vitest";
import { MdbaseCollectionClient } from "./collection-client.js";
import { connectSuccess } from "./outcomes.js";
import { wireQueryInput } from "./query-wire.js";
import type { QueryInput } from "./operation-types.js";

// mdbase-connect v0.1.0-beta.126 delegates to mdbase::api::QueryRequest:
// select: Option<Vec<String>>. Maps fail before the query is evaluated.
function beta126Selection(input: Record<string, unknown>) {
  if ((input.select as unknown[] | undefined)?.some(value => typeof value !== "string"))
    throw new Error("invalid typed request: invalid type: map, expected a string");
}

describe("beta.126 typed query selections", () => {
  it("reproduces the legacy deserializer failure for the previous wire shape", () => {
    expect(() => beta126Selection({ select: [{ name: "title", expr: "record.title" }] })).toThrow("expected a string");
  });

  it.each([undefined, "metadata"] as const)("preserves named values in %s queries without overwriting projections or literal selections", async output => {
    const input = {
      ...(output ? { output } : {}),
      types: ["task"], where: "status == 'open'", limit: 10,
      projections: { connect_select_1: { expression: "true" }, title: { expression: "record.title" } },
      select: ["projection.connect_select_1", { name: "title.with.dots", expression: "record.title", label: "Title" }, { name: "__proto__", expression: "file.path" }],
      orderBy: [{ field: "title.with.dots", direction: "asc" as const }]
    };
    const before = structuredClone(input);
    const operation = vi.fn(async (_operation: string, raw: unknown) => {
      const wire = raw as Record<string, unknown>;
      beta126Selection(wire);
      expect(wire).toMatchObject({
        where: input.where, types: ["task"], limit: 10,
        select: ["projection.connect_select_1", "projection.connect_select_1_", "projection.connect_select_2"],
        projections: { connect_select_1_: { expr: "record.title" }, connect_select_2: { expr: "file.path" }, title: { expr: "record.title" } },
        order_by: [{ field: "connect_select_1_", direction: "asc" }]
      });
      return { valid: true, diagnostics: [], result: {
        ...(output ? { output } : {}),
        results: [{ path: "one.md", types: ["task"], revision: "opaque:1", values: { connect_select_1: true, connect_select_1_: "Title", connect_select_2: "one.md" } }],
        meta: { has_more: false }
      } };
    });
    const client = new MdbaseCollectionClient({ operation: operation as any }, 1000, async () => connectSuccess(true));
    const result = await client.query(input);
    expect(result).toMatchObject({ ok: true, value: { results: [{ values: { connect_select_1: true, "title.with.dots": "Title", ["__proto__"]: "one.md" } }] } });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(input).toEqual(before);
  });

  it("leaves ordinary string selections and ordering unchanged", () => {
    const input: QueryInput = { where: "true", select: ["title"], orderBy: [{ field: "title", direction: "desc" }] };
    expect(wireQueryInput(input)).toEqual({ where: "true", select: ["title"], order_by: input.orderBy });
  });
});
