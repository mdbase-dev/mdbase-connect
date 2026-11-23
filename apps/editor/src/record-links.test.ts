import { describe, expect, it } from "vitest";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { linkTargetTypes, linkValue, linkValueLabel, recordLinkProperties, resolvableLinkValue, typeLinkProperties } from "./record-links";

const book: CollectionTypeDescriptor = {
  name: "book",
  schema: { type: "object", properties: { author: { type: "string" }, characters: { type: "array", items: { type: "string" } } } },
  collection: {
    links: {
      author: { target_type: "person", validate_exists: true },
      "characters[]": { target_type: ["person", "creature"], format: "markdown" },
      "reviews[].by": { target_type: "person" },
      source: { target_type: "any", format: "path" }
    }
  },
  extensions: {}
};

describe("link properties", () => {
  it("reads one link, a list of links and the open target from a type's rules", () => {
    const properties = typeLinkProperties(book);
    expect(properties.get("author")).toEqual({ field: "author", many: false, targetTypes: ["person"], format: "wikilink" });
    expect(properties.get("characters")).toEqual({ field: "characters", many: true, targetTypes: ["person", "creature"], format: "markdown" });
    expect(properties.get("source")).toEqual({ field: "source", many: false, targetTypes: [], format: "path" });
  });

  it("leaves rules on nested values out: they are not properties of the record", () => {
    expect([...typeLinkProperties(book).keys()]).toEqual(["author", "characters", "source"]);
  });

  it("reads rules from a definition when the descriptor carries no collection section", () => {
    const described: CollectionTypeDescriptor = { name: "book", schema: {}, definition: { collection: book.collection! }, extensions: {} };
    expect(typeLinkProperties(described).has("author")).toBe(true);
  });

  it("gives a record the rules of its types, whatever case the type is written in", () => {
    expect(recordLinkProperties(["Book"], [book]).get("author")?.targetTypes).toEqual(["person"]);
    expect(recordLinkProperties(["note"], [book]).size).toBe(0);
  });

  it("treats `any` as no restriction", () => {
    expect(linkTargetTypes("any")).toEqual([]);
    expect(linkTargetTypes(["person", "any"])).toEqual([]);
    expect(linkTargetTypes(undefined)).toEqual([]);
  });
});

describe("link values", () => {
  it("writes a link from the collection root in the rule's format", () => {
    expect(linkValue("People/Ada Lovelace.md", "Ada Lovelace", "wikilink")).toBe("[[People/Ada Lovelace]]");
    expect(linkValue("People/Ada Lovelace.md", "Ada [Lovelace]", "markdown")).toBe("[Ada Lovelace](</People/Ada Lovelace.md>)");
    expect(linkValue("People/Ada Lovelace.md", "Ada Lovelace", "path")).toBe("/People/Ada Lovelace.md");
  });

  it("asks the collection about a bare path as the Markdown link it stands for", () => {
    expect(resolvableLinkValue("[[Ada]]")).toBe("[[Ada]]");
    expect(resolvableLinkValue("[Ada](people/ada.md)")).toBe("[Ada](people/ada.md)");
    expect(resolvableLinkValue("people/ada lovelace.md")).toBe("[](<people/ada lovelace.md>)");
    expect(resolvableLinkValue("  ")).toBeUndefined();
  });

  it("names a value by its alias, its link text or the end of its target", () => {
    expect(linkValueLabel("[[People/Ada Lovelace|Ada]]")).toBe("Ada");
    expect(linkValueLabel("[[People/Ada Lovelace#Early life]]")).toBe("Ada Lovelace");
    expect(linkValueLabel("[](</People/Ada%20Lovelace.md>)")).toBe("Ada Lovelace");
    expect(linkValueLabel("People/Ada Lovelace.md")).toBe("Ada Lovelace");
  });
});
