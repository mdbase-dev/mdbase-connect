import { describe, expect, it } from "vitest";
import {
  addTypeField,
  readVisualType,
  removeTypeField,
  renameTypeField,
  setTypeFieldChoices,
  setTypeFieldConstraint,
  setTypeFieldKind,
  setTypeFieldRequired,
  setTypeListItemKind,
  typeFieldConversionImpact,
  typeFieldPathLabel,
  typeImpact,
  updateTypeFieldsPresent,
  updateTypePathGlob,
  updateTypePathGlobs
} from "./type-schema";
import type { NoteSummary } from "./model";

const source = `---
kind: mdbase.type
name: task
description: Work to do
extension:
  preserved: true
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title:
        type: string
        minLength: 1
      due:
        type: string
        format: date
    required: [title]
---
Body text stays here.
`;

describe("visual type source editing", () => {
  it("reads common JSON Schema fields", () => {
    expect(readVisualType(source)).toMatchObject({
      name: "task",
      fields: [
        { name: "title", kind: "string", required: true },
        { name: "due", kind: "date", required: false }
      ]
    });
  });

  it("preserves extensions and body content while changing visual fields", () => {
    let next = renameTypeField(source, "due", "deadline");
    next = setTypeFieldKind(next, "deadline", "datetime");
    next = setTypeFieldRequired(next, "deadline", true);
    next = addTypeField(next);

    expect(next).toContain("preserved: true");
    expect(next).toContain("Body text stays here.");
    expect(readVisualType(next).fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "deadline", kind: "datetime", required: true }),
      expect.objectContaining({ name: "field", kind: "string" })
    ]));
  });

  it("keeps every selected required field when the YAML uses a sequence node", () => {
    let next = setTypeFieldRequired(source, "due", true);
    next = addTypeField(next);
    next = setTypeFieldRequired(next, "field", true);

    expect(readVisualType(next).fields.filter((field) => field.required).map((field) => field.name)).toEqual([
      "title",
      "due",
      "field"
    ]);

    next = setTypeFieldRequired(next, "due", false);
    expect(readVisualType(next).fields.filter((field) => field.required).map((field) => field.name)).toEqual([
      "title",
      "field"
    ]);
  });

  it("reports how a change affects currently indexed notes", () => {
    const next = setTypeFieldRequired(addTypeField(source), "field", true);
    const notes: NoteSummary[] = [
      noteSummary("one.md", { type: "task", title: "One" }, ["task"]),
      noteSummary("two.md", { type: "task", title: "Two", field: "present" }, ["task"]),
      noteSummary("other.md", {}, [])
    ];

    expect(typeImpact(source, next, notes, "task")).toMatchObject({
      addedFields: ["field"],
      newlyRequired: ["field"],
      affectedNotes: 2,
      missingRequired: [{ field: "field", count: 1 }]
    });
  });
});

const recursiveSource = `---
kind: mdbase.type
name: person
description: People and their contact details
match:
  path_glob: "People/**/*.md"
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: false
    properties:
      title:
        type: string
      profile:
        type: object
        additionalProperties: false
        required: [display_name]
        properties:
          display_name:
            type: string
            minLength: 1
          timezone:
            type: string
      contacts:
        type: array
        minItems: 1
        items:
          type: object
          additionalProperties: false
          required: [kind]
          properties:
            kind:
              type: string
              enum: [email, phone]
            value:
              type: string
              x-local-rule: preserved
      matrix:
        type: array
        items:
          type: array
          items:
            type: integer
    required: [title, profile]
---
# Person

The Markdown body is documentation.
`;

describe("recursive visual type source editing", () => {
  it("reads objects, lists of objects, nested lists, constraints, and local required fields", () => {
    const definition = readVisualType(recursiveSource);
    expect(definition.pathGlob).toBe("People/**/*.md");
    const profile = definition.fields.find((field) => field.name === "profile")!;
    const contacts = definition.fields.find((field) => field.name === "contacts")!;
    const matrix = definition.fields.find((field) => field.name === "matrix")!;

    expect(profile).toMatchObject({
      kind: "object",
      required: true,
      constraints: { additionalProperties: false },
      fields: [
        { name: "display_name", kind: "string", required: true, constraints: { minLength: 1 } },
        { name: "timezone", kind: "string", required: false }
      ]
    });
    expect(contacts).toMatchObject({
      kind: "array",
      constraints: { minItems: 1 },
      item: {
        kind: "object",
        constraints: { additionalProperties: false },
        fields: [
          { name: "kind", required: true, constraints: { choices: ["email", "phone"] } },
          { name: "value", required: false }
        ]
      }
    });
    expect(matrix.item?.kind).toBe("array");
    expect(matrix.item?.item?.kind).toBe("integer");
    expect(typeFieldPathLabel(contacts.item!.fields[1].path)).toBe("contacts[].value");
  });

  it("marks every rule not represented by visual controls as advanced", () => {
    const value = readVisualType(recursiveSource).fields
      .find((field) => field.name === "contacts")!.item!.fields
      .find((field) => field.name === "value")!;
    expect(value.advancedKeys).toEqual(["x-local-rule"]);

    const withRules = recursiveSource.replace("minLength: 1", `minLength: 1
            default: Anonymous
            format: email`);
    const displayName = readVisualType(withRules).fields
      .find((field) => field.name === "profile")!.fields
      .find((field) => field.name === "display_name")!;
    expect(displayName.advancedKeys).toEqual(expect.arrayContaining(["default", "format"]));
  });

  it("adds, renames, requires, constrains, and removes fields inside list item objects", () => {
    const contacts = readVisualType(recursiveSource).fields.find((field) => field.name === "contacts")!;
    let next = addTypeField(recursiveSource, contacts.item!.path);
    let added = readVisualType(next).fields.find((field) => field.name === "contacts")!.item!.fields.find((field) => field.name === "field")!;
    next = renameTypeField(next, added.path, "label");
    added = readVisualType(next).fields.find((field) => field.name === "contacts")!.item!.fields.find((field) => field.name === "label")!;
    next = setTypeFieldRequired(next, added.path, true);
    next = setTypeFieldChoices(next, added.path, ["home", "work", "home"]);
    next = setTypeFieldConstraint(next, added.path, "minLength", 2);

    const label = readVisualType(next).fields.find((field) => field.name === "contacts")!.item!.fields.find((field) => field.name === "label")!;
    expect(label).toMatchObject({ required: true, constraints: { choices: ["home", "work"], minLength: 2 } });
    expect(next).toContain("x-local-rule: preserved");
    expect(next).toContain("The Markdown body is documentation.");

    next = removeTypeField(next, label.path);
    const itemFields = readVisualType(next).fields.find((field) => field.name === "contacts")!.item!.fields;
    expect(itemFields.some((field) => field.name === "label")).toBe(false);
  });

  it("identifies destructive conversions before replacing recursive structure", () => {
    const contacts = readVisualType(recursiveSource).fields.find((field) => field.name === "contacts")!;
    expect(typeFieldConversionImpact(recursiveSource, contacts.path, "string")).toEqual(expect.arrayContaining([
      "list item schema",
      "minimum items"
    ]));

    const converted = setTypeFieldKind(recursiveSource, contacts.path, "string");
    const nextContacts = readVisualType(converted).fields.find((field) => field.name === "contacts")!;
    expect(nextContacts.kind).toBe("string");
    expect(nextContacts.item).toBeUndefined();
    expect(converted).toContain("The Markdown body is documentation.");
  });

  it("changes list item kinds without flattening the containing list", () => {
    const matrix = readVisualType(recursiveSource).fields.find((field) => field.name === "matrix")!;
    const next = setTypeListItemKind(recursiveSource, matrix.path, "object");
    const changed = readVisualType(next).fields.find((field) => field.name === "matrix")!;
    expect(changed.kind).toBe("array");
    expect(changed.item).toMatchObject({ kind: "object", fields: [], constraints: { additionalProperties: true } });
  });

  it("reports nested required paths and notes containing invalid list items", () => {
    const contacts = readVisualType(recursiveSource).fields.find((field) => field.name === "contacts")!;
    const value = contacts.item!.fields.find((field) => field.name === "value")!;
    const next = setTypeFieldRequired(recursiveSource, value.path, true);
    const notes: NoteSummary[] = [
      noteSummary("complete.md", { type: "person", contacts: [{ kind: "email", value: "a@example.com" }] }, ["person"]),
      noteSummary("missing.md", { type: "person", contacts: [{ kind: "phone" }] }, ["person"]),
      noteSummary("without-optional-list.md", { type: "person" }, ["person"])
    ];
    expect(typeImpact(recursiveSource, next, notes, "person")).toMatchObject({
      newlyRequired: ["contacts[].value"],
      affectedNotes: 3,
      missingRequired: [{ field: "contacts[].value", count: 1 }]
    });
  });

  it("classifies matching and constraint edits in the review", () => {
    const profile = readVisualType(recursiveSource).fields.find((field) => field.name === "profile")!;
    const displayName = profile.fields.find((field) => field.name === "display_name")!;
    let next = setTypeFieldConstraint(recursiveSource, displayName.path, "minLength", 3);
    next = updateTypePathGlob(next, "Contacts/**/*.md");
    expect(typeImpact(recursiveSource, next, [], "person")).toMatchObject({
      changedFields: ["profile.display_name"],
      definitionChanges: ["Matching rules"]
    });
  });

  it("edits all portable inferred match selectors and removes an empty match section", () => {
    let next = updateTypePathGlobs(recursiveSource, ["People/**/*.md", "Contacts/**/*.md"]);
    next = updateTypeFieldsPresent(next, ["profile", "status"]);
    expect(readVisualType(next)).toMatchObject({
      pathGlobs: ["People/**/*.md", "Contacts/**/*.md"],
      fieldsPresent: ["profile", "status"],
      advancedMatchKeys: []
    });

    next = updateTypeFieldsPresent(next, []);
    next = updateTypePathGlobs(next, []);
    expect(next).not.toContain("match:");
    expect(readVisualType(next)).toMatchObject({ pathGlobs: [], fieldsPresent: [] });
  });
});

function noteSummary(
  path: string,
  frontmatter: NoteSummary["frontmatter"],
  types: string[]
): NoteSummary {
  return {
    path,
    frontmatter,
    effective_frontmatter: structuredClone(frontmatter),
    types,
    file: {
      path,
      name: path,
      folder: "",
      size: 0,
      mtime: ""
    }
  };
}
