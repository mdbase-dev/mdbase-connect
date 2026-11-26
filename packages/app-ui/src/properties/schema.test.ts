import { describe, expect, it } from "vitest";

import { mergeTypeSchemas, propertiesFromSchema } from "./schema.js";

describe("propertiesFromSchema", () => {
  it("names each field's kind, what it may hold, and whether the record must have it", () => {
    expect(propertiesFromSchema({
      title: { type: "string", description: "A human-readable title." },
      status: { type: ["string", "null"], enum: ["draft", "done", null] },
      rating: { type: "integer" },
      done: { type: "boolean" },
      due: { type: "string", format: "date" },
      starts: { type: "string", format: "date-time" },
    }, ["title"])).toEqual([
      { name: "title", kind: "text", required: true, description: "A human-readable title." },
      { name: "status", kind: "text", options: ["draft", "done"] },
      { name: "rating", kind: "number" },
      { name: "done", kind: "boolean" },
      { name: "due", kind: "text", format: "date" },
      { name: "starts", kind: "text", format: "date-time" },
    ]);
  });

  it("describes a value with parts by its parts, and a list by what each value is", () => {
    const [profile, contacts, tags] = propertiesFromSchema({
      profile: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" }, age: { type: "number" } } },
      contacts: { type: "array", items: { required: ["value"], properties: { value: { type: "string" } }, additionalProperties: { type: "boolean" } } },
      tags: { type: "array", items: { type: "string" } },
    }, []);
    expect(profile).toEqual({ name: "profile", kind: "group", rest: false, parts: [{ name: "name", kind: "text", required: true }, { name: "age", kind: "number" }] });
    expect(contacts).toEqual({ name: "contacts", kind: "list", items: {
      name: "", kind: "group", parts: [{ name: "value", kind: "text", required: true }], rest: { name: "", kind: "boolean" },
    } });
    expect(tags).toEqual({ name: "tags", kind: "list", items: { name: "", kind: "text" } });
  });

  it("follows a schema's own definitions, and stops where one describes itself without end", () => {
    const tree = { $ref: "#/$defs/node", $defs: { node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } } } } };
    let info = propertiesFromSchema({ tree }, [])[0]!;
    let depth = 0;
    while (info.parts?.[0]?.items) { info = info.parts[0].items; depth += 1; }
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(8);
    expect(info.kind).toBe("group");
  });

  it("describes a field that may be a day or a moment as the one the record holds", () => {
    const either = { anyOf: [{ type: "string", format: "date" }, { type: "string", format: "date-time" }, { type: "null" }] };
    const formats = (values: Record<string, string>) => propertiesFromSchema({ due: either }, [], undefined, values).map((info) => info.format);
    expect(formats({})).toEqual(["date"]);
    expect(formats({ due: "2026-07-21" })).toEqual(["date"]);
    expect(formats({ due: "2026-07-21T05:15:30Z" })).toEqual(["date-time"]);
  });

  it("marks a linking field, and keeps a required field no type describes", () => {
    expect(propertiesFromSchema({ reviewers: { type: "array", items: { type: "string" } } }, ["owner"], new Map([["reviewers", { many: true }]]))).toEqual([
      { name: "reviewers", kind: "list", items: { name: "", kind: "text" }, link: { many: true } },
      { name: "owner", kind: "other", required: true },
    ]);
  });
});

describe("mergeTypeSchemas", () => {
  it("takes every type's properties, a later type's over an earlier one's, and all their required fields", () => {
    expect(mergeTypeSchemas([
      { properties: { title: { type: "string" }, due: { type: "string" } }, required: ["title"] },
      { properties: { due: { type: "string", format: "date" }, done: { type: "boolean" }, odd: "not a schema" }, required: ["due", "title"] },
      {},
    ])).toEqual({
      properties: { title: { type: "string" }, due: { type: "string", format: "date" }, done: { type: "boolean" } },
      required: ["title", "due"],
    });
  });
});
