import type { CollectionTypeDescriptor, JsonObject } from "@mdbase-dev/connect";
import { describe, expect, it } from "vitest";
import {
  collectionDisplayField,
  fieldReferenceName,
  fieldReferencePatch,
  fieldReferencePath,
  readFieldReference,
  recordDisplayField,
  writeFieldReference
} from "./field-reference";

describe("collection display field references", () => {
  it("reads dot paths and RFC 6901 JSON Pointers", () => {
    const value = {
      profile: {
        display_name: "Ada Lovelace",
        "name/short": "Ada",
        "name~formal": "Augusta Ada King"
      }
    };

    expect(fieldReferencePath("profile.display_name")).toEqual(["profile", "display_name"]);
    expect(fieldReferencePath("/profile/name~1short")).toEqual(["profile", "name/short"]);
    expect(fieldReferencePath("/profile/name~0formal")).toEqual(["profile", "name~formal"]);
    expect(fieldReferenceName("/profile/display_name")).toBe("display_name");
    expect(readFieldReference(value, "profile.display_name")).toBe("Ada Lovelace");
    expect(readFieldReference(value, "/profile/name~1short")).toBe("Ada");
  });

  it("writes nested paths without mutating the original value", () => {
    const value = {
      profile: { display_name: "Ada Lovelace", timezone: "Europe/London" },
      category: "person"
    };

    expect(writeFieldReference(value, "/profile/display_name", "Grace Hopper")).toEqual({
      profile: { display_name: "Grace Hopper", timezone: "Europe/London" },
      category: "person"
    });
    expect(value.profile.display_name).toBe("Ada Lovelace");
  });

  it("builds a shallow runtime patch that preserves nested siblings", () => {
    const value = {
      profile: { display_name: "Ada Lovelace", timezone: "Europe/London" },
      category: "person"
    };

    expect(fieldReferencePatch(value, "profile.display_name", "Grace Hopper")).toEqual({
      profile: { display_name: "Grace Hopper", timezone: "Europe/London" }
    });
  });

  it("supports existing array positions in JSON Pointers", () => {
    const value: JsonObject = { names: [{ value: "Ada" }, { value: "Lovelace" }] };
    expect(readFieldReference(value, "/names/1/value")).toBe("Lovelace");
    expect(writeFieldReference(value, "/names/0/value", "Augusta")).toEqual({
      names: [{ value: "Augusta" }, { value: "Lovelace" }]
    });
  });

  it("uses only declared display metadata and resolves record types deterministically", () => {
    const contact = displayType("contact", "/profile/display_name");
    const organization = displayType("organization", "legal_name");

    expect(collectionDisplayField(contact, "name_field")).toBe("/profile/display_name");
    expect(recordDisplayField(["ORGANIZATION", "contact"], [contact, organization], "name_field")).toBe("legal_name");
    expect(recordDisplayField(["unknown", "contact"], [contact, organization], "name_field")).toBe("/profile/display_name");
    expect(recordDisplayField(["unknown"], [contact, organization], "name_field")).toBeUndefined();
  });

  it("does not treat collection path expansion as a scalar display field", () => {
    expect(fieldReferencePath("contacts[].value")).toBeUndefined();
  });
});

function displayType(name: string, nameField: string): CollectionTypeDescriptor {
  return {
    name,
    definition: {},
    collection: { display: { name_field: nameField } },
    schema: { type: "object" },
    extensions: {}
  };
}
