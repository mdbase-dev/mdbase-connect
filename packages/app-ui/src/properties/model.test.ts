import { describe, expect, it } from "vitest";

import {
  describeProperty, filterFieldsFromProperties, inferProperty, isEmptyValue, isPropertyName, linkLabel, linkToPath, parseValue, pathToLink,
  propertiesInUse, propertyKind, valueLine,
} from "./model.js";

describe("isEmptyValue", () => {
  it("counts nothing, empty text and empty lists as empty, and false and zero as values", () => {
    for (const value of [undefined, null, "", [], {}]) expect(isEmptyValue(value)).toBe(true);
    for (const value of [false, 0, "a", ["a"], { a: 1 }]) expect(isEmptyValue(value)).toBe(false);
  });
});

describe("parseValue", () => {
  it("reads what was typed as the value it most plainly means", () => {
    expect(parseValue(" 3 ")).toBe(3);
    expect(parseValue("-2.5")).toBe(-2.5);
    expect(parseValue("true")).toBe(true);
    expect(parseValue("false")).toBe(false);
    expect(parseValue("null")).toBeNull();
    expect(parseValue("3 apples")).toBe("3 apples");
    expect(parseValue("1.2.3")).toBe("1.2.3");
  });
});

describe("propertyKind", () => {
  it("goes by what the value holds", () => {
    expect(propertyKind("open", undefined)).toBe("text");
    expect(propertyKind(4, undefined)).toBe("number");
    expect(propertyKind(false, undefined)).toBe("boolean");
    expect(propertyKind("2026-11-28", undefined)).toBe("date");
    expect(propertyKind(["a", "b"], undefined)).toBe("tags");
    expect(propertyKind("[[notes/one]]", undefined)).toBe("links");
    expect(propertyKind(["[[notes/one]]", "[[notes/two|Two]]"], undefined)).toBe("links");
    expect(propertyKind("one\ntwo", undefined)).toBe("long");
    expect(propertyKind({ status: "reading" }, undefined)).toBe("other");
    expect(propertyKind([{ a: 1 }], undefined)).toBe("other");
  });

  it("goes by what is known of the property when there is nothing to go by", () => {
    expect(propertyKind(undefined, { name: "done", kind: "boolean" })).toBe("boolean");
    expect(propertyKind(null, { name: "tags", kind: "list" })).toBe("tags");
    expect(propertyKind("", { name: "count", kind: "number" })).toBe("number");
    expect(propertyKind(undefined, { name: "due", kind: "text", format: "date" })).toBe("date");
    expect(propertyKind(undefined, undefined)).toBe("text");
  });

  it("offers a choice where the values are listed", () => {
    const status = { name: "status", kind: "text", options: ["open", "done"] } as const;
    expect(propertyKind("open", status)).toBe("choice");
    expect(propertyKind(undefined, status)).toBe("choice");
    // A value that is a list where one was not expected is still shown for what it is.
    expect(propertyKind(["open"], status)).toBe("tags");
  });

  it("does not take a date-shaped string for a date when the property is plain text", () => {
    expect(propertyKind("2026-11-28", { name: "code", kind: "text" })).toBe("text");
    expect(propertyKind("not a date", { name: "due", kind: "text", format: "date" })).toBe("text");
  });
});

describe("describeProperty", () => {
  const declared = [{ name: "status", kind: "text", options: ["open", "done"] }] as const;
  const inUse = [{ name: "stage", kind: "text", options: ["draft", "final", 3] }] as const;

  it("takes what the type declares as it is", () => {
    expect(describeProperty("status", declared, inUse)).toEqual({ info: declared[0], suggestions: undefined, own: true });
  });

  it("offers what other records hold as suggestions, not as the only choices", () => {
    expect(describeProperty("stage", declared, inUse)).toEqual({ info: { name: "stage", kind: "text" }, suggestions: ["draft", "final"], own: false });
    expect(describeProperty("pages", declared, inUse)).toEqual({ info: undefined, suggestions: undefined, own: false });
  });
});

describe("links", () => {
  it("reads a link as the path it points at", () => {
    expect(linkToPath("[[sources/crime|Crime]]")).toBe("sources/crime.md");
    expect(linkToPath("[[sources/crime#p3]]")).toBe("sources/crime.md");
    expect(linkToPath("![[files/scan.pdf]]")).toBe("files/scan.pdf");
    expect(linkToPath("/notes/one")).toBe("notes/one.md");
    expect(linkToPath("[[]]")).toBeNull();
  });

  it("writes a path as a link, and a link as the words it shows", () => {
    expect(pathToLink("sources/crime.md")).toBe("[[sources/crime]]");
    expect(pathToLink("files/scan.pdf")).toBe("[[files/scan.pdf]]");
    expect(linkLabel("[[sources/crime|Crime and Punishment]]")).toBe("Crime and Punishment");
    expect(linkLabel("[[sources/crime#p3]]")).toBe("crime");
    expect(linkLabel("plain text")).toBe("plain text");
  });
});

describe("valueLine", () => {
  const words = { yes: "yes", no: "no" };

  it("writes a value on one line where it fits on one", () => {
    expect(valueLine(" open ", words)).toBe("open");
    expect(valueLine(4, words)).toBe("4");
    expect(valueLine(true, words)).toBe("yes");
    expect(valueLine(false, { yes: "oui", no: "non" })).toBe("non");
    expect(valueLine("2026-11-28T10:00:00Z", words)).toBe("2026-11-28");
    expect(valueLine(["[[people/ada|Ada]]", "[[people/alan]]"], words)).toBe("Ada, alan");
  });

  it("gives up on what does not", () => {
    expect(valueLine("one\ntwo", words)).toBeUndefined();
    expect(valueLine("x".repeat(81), words)).toBeUndefined();
    expect(valueLine([1, 2], words)).toBeUndefined();
    expect(valueLine({ a: 1 }, words)).toBeUndefined();
    expect(valueLine(null, words)).toBeUndefined();
  });
});

describe("inferProperty", () => {
  it("goes by what every value is", () => {
    expect(inferProperty("done", [true, false])).toEqual({ name: "done", kind: "boolean" });
    expect(inferProperty("pages", [1, 320])).toEqual({ name: "pages", kind: "number" });
    expect(inferProperty("tags", [["a"], []])).toEqual({ name: "tags", kind: "list" });
    expect(inferProperty("due", ["2026-11-28", "2026-12-01"])).toEqual({ name: "due", kind: "text", format: "date" });
    expect(inferProperty("at", ["2026-11-28T10:00:00Z"])).toEqual({ name: "at", kind: "text", format: "date-time" });
    expect(inferProperty("mixed", [1, "one"])).toEqual({ name: "mixed", kind: "other" });
    expect(inferProperty("author", ["[[people/ada]]"])).toEqual({ name: "author", kind: "other" });
    expect(inferProperty("none", [])).toBeUndefined();
  });

  it("reads a few short values, or values that repeat, as a set to choose from", () => {
    expect(inferProperty("stage", ["final", "draft", "final"])).toEqual({ name: "stage", kind: "text", options: ["draft", "final"] });
    expect(inferProperty("place", ["New York", "New York", "San Jose", "San Jose"])).toEqual({ name: "place", kind: "text", options: ["New York", "San Jose"] });
    expect(inferProperty("title", ["A long title", "Another one entirely"])).toEqual({ name: "title", kind: "text" });
    expect(inferProperty("word", Array.from({ length: 13 }, (_unused, index) => `w${String(index)}`))).toEqual({ name: "word", kind: "text" });
  });
});

describe("propertiesInUse", () => {
  const declared = [{ name: "status", kind: "text", options: ["open", "done"] }] as const;
  const records = [
    { status: "open", pages: 12, stage: "draft", "not a name": 1, type: "book", note: null },
    { status: "weird", pages: 320, stage: "final", due: "" },
  ];

  it("lists what is declared first, as declared, then what the records hold", () => {
    expect(propertiesInUse(records, declared)).toEqual([
      declared[0],
      { name: "pages", kind: "number" },
      { name: "stage", kind: "text", options: ["draft", "final"] },
      { name: "type", kind: "text", options: ["book"] },
    ]);
  });

  it("leaves out the names it is told to", () => {
    expect(propertiesInUse(records, [], (name) => name === "type" || name === "status").map((field) => field.name)).toEqual(["pages", "stage"]);
  });
});

describe("filterFieldsFromProperties", () => {
  it("offers the properties whose values can be compared, by name", () => {
    expect(filterFieldsFromProperties([
      { name: "status", kind: "text", options: ["open", null, "done"] },
      { name: "pages", kind: "number" },
      { name: "done", kind: "boolean" },
      { name: "due", kind: "text", format: "date" },
      { name: "at", kind: "text", format: "date-time" },
      { name: "author", kind: "text" },
      { name: "tags", kind: "list" },
      { name: "meta", kind: "other" },
    ])).toEqual([
      { key: "at", kind: "date" },
      { key: "author", kind: "string" },
      { key: "done", kind: "boolean" },
      { key: "due", kind: "date" },
      { key: "pages", kind: "number" },
      { key: "status", kind: "enum", enumValues: ["open", "done"] },
    ]);
  });
});

describe("isPropertyName", () => {
  it("takes letters, digits, - _ and :, not starting with a digit", () => {
    expect(["pages", "date_created", "dc:title", "_x", "a-b"].every(isPropertyName)).toBe(true);
    expect(["2 much", "2nd", "a b", "", "é"].some(isPropertyName)).toBe(false);
  });
});
