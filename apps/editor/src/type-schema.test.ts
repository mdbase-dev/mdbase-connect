import { describe, expect, it } from "vitest";
import {
  addTypeField,
  addTypeLinkRule,
  addTypeReadDefault,
  addTypeUniqueRule,
  readVisualType,
  removeTypeLinkRule,
  removeTypeReadDefault,
  removeTypeUniqueRule,
  removeTypeField,
  renameTypeLinkRule,
  renameTypeReadDefault,
  renameTypeField,
  setTypeLinkRule,
  setTypeLinkTargets,
  setTypeReadDefault,
  setTypeFieldChoices,
  setTypeFieldConstraint,
  setTypeFieldDescription,
  setTypeFieldKind,
  setTypeFieldRequired,
  setTypeListItemKind,
  setTypeUniqueRule,
  typeFieldConversionImpact,
  typeFieldPathLabel,
  typeImpact,
  updateTypeCollectionDisplay,
  updateTypeFieldsPresent,
  updateTypePathPolicy,
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

  it("renames contract mapping targets with the field they reference", () => {
    const mapped = recursiveSource.replace("name: person\n", `name: person
implements:
  - contract: example.person
    version: 1.0.0
    fields:
      name: title
      email: profile.display_name
  - contract: example.directory-entry
    version: 1.0.0
    fields:
      /contact/email: /profile/display_name
`);

    let next = renameTypeField(mapped, "title", "name");
    next = renameTypeField(next, ["properties", "profile", "properties", "display_name"], "label");

    expect(next).toContain("name: name");
    expect(next).toContain("email: profile.label");
    expect(next).toContain("/contact/email: /profile/label");
    expect(next).not.toContain("profile.display_name");
    expect(next).not.toContain("/profile/display_name");
  });

  it("preserves contract implementations when adding and renaming a field beside an advanced map", () => {
    const mapped = source.replace("extension:", `implements:
  - contract: example.task
    version: 1.0.0
    fields:
      title: title
extension:`).replace("    required: [title]", `      organizations:
        type: object
        propertyNames:
          type: string
          minLength: 1
        additionalProperties:
          type: object
          properties:
            name: { type: string, minLength: 1 }
          additionalProperties: false
    required: [title]`);

    const added = addTypeField(mapped);
    const renamed = renameTypeField(added, "field", "local_context");

    expect(added).toContain("contract: example.task");
    expect(renamed).toContain("contract: example.task");
    expect(renamed).toContain("local_context:");
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

  it("previews notes that gain and lose membership through visual match rules", () => {
    const previous = updateTypePathGlobs(source, ["Archive/**/*.md"]);
    let next = updateTypePathGlobs(previous, ["Tasks/**/*.md"]);
    next = updateTypeFieldsPresent(next, ["status"]);
    const notes: NoteSummary[] = [
      noteSummary("Inbox/explicit.md", { type: "task", title: "Explicit" }, ["task"]),
      noteSummary("Archive/old.md", { status: "open", title: "Old" }, ["task"]),
      noteSummary("Tasks/new.md", { status: "open", title: "New" }, ["project"]),
      noteSummary("Tasks/missing.md", { title: "Missing status" }, []),
      noteSummary("Tasks/other.md", { type: "project", status: "open", title: "Other" }, ["project"])
    ];

    expect(typeImpact(previous, next, notes, "task").membership).toEqual({
      current: 2,
      next: 2,
      addedPaths: ["Tasks/new.md"],
      removedPaths: ["Archive/old.md"],
      overlapping: 1,
      complete: true
    });
  });

  it("uses configured explicit keys when previewing membership", () => {
    const next = updateTypePathGlobs(source, ["Notes/**/*.md"]);
    const notes: NoteSummary[] = [
      noteSummary("Notes/custom.md", { kind: "task" }, ["task"]),
      noteSummary("Notes/default-key.md", { type: "project" }, ["project"])
    ];

    expect(typeImpact(source, next, notes, "task", ["kind"]).membership).toMatchObject({
      next: 2,
      addedPaths: ["Notes/default-key.md"]
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

const collectionSource = recursiveSource.replace("schema:", `collection:
  display:
    name_field: title
    description_field: profile.display_name
    icon: person
    color_field: profile.timezone
  read_defaults:
    profile:
      timezone: UTC
  links:
    contacts[].value:
      target_type: [person, organisation]
      validate_exists: true
      format: wikilink
  unique:
    - field: title
      scope: type
    - field: contacts[].value
      scope: path_glob
      path_glob: People/**/*.md
  path:
    pattern: "People/{title}.md"
    runtime: example.paths
  projections:
    label:
      expr: title
  x-example:
    preserved: true
schema:`);

describe("recursive visual type source editing", () => {
  it("reads portable collection behaviour while identifying YAML-only settings", () => {
    expect(readVisualType(collectionSource).collection).toMatchObject({
      display: {
        nameField: "title",
        descriptionField: "profile.display_name",
        icon: "person",
        colorField: "profile.timezone"
      },
      readDefaults: [{ field: "profile", value: { timezone: "UTC" } }],
      links: [{
        field: "contacts[].value",
        targetTypes: ["person", "organisation"],
        validateExists: true,
        format: "wikilink",
        advancedKeys: []
      }],
      unique: [
        { sourceIndex: 0, field: "title", scope: "type" },
        { sourceIndex: 1, field: "contacts[].value", scope: "path_glob", pathGlob: "People/**/*.md" }
      ],
      path: {
        pattern: "People/{title}.md",
        advancedKeys: ["runtime"]
      },
      advancedKeys: ["projections", "x-example"]
    });
  });

  it("edits collection behaviour without disturbing projections, extensions, or documentation", () => {
    let next = updateTypeCollectionDisplay(collectionSource, "icon", "contact");
    next = updateTypeCollectionDisplay(next, "description_field", "");
    next = setTypeReadDefault(next, "profile", { timezone: "Australia/Melbourne" });
    next = addTypeReadDefault(next, "title", "Untitled person");
    next = renameTypeReadDefault(next, "title", "timezone");
    next = addTypeLinkRule(next, "profile.display_name");
    next = setTypeLinkTargets(next, "profile.display_name", ["person"]);
    next = setTypeLinkRule(next, "profile.display_name", "validate_exists", true);
    next = renameTypeLinkRule(next, "profile.display_name", "profile.timezone");
    next = setTypeUniqueRule(next, 0, "scope", "collection");
    next = addTypeUniqueRule(next, "profile.display_name");
    next = updateTypePathPolicy(next, "pattern", "Contacts/{title}.md");
    next = updateTypePathPolicy(next, "folder", "Contacts");

    expect(readVisualType(next).collection).toMatchObject({
      display: { nameField: "title", icon: "contact" },
      readDefaults: [
        { field: "profile", value: { timezone: "Australia/Melbourne" } },
        { field: "timezone", value: "Untitled person" }
      ],
      links: expect.arrayContaining([
        expect.objectContaining({ field: "profile.timezone", targetTypes: ["person"], validateExists: true })
      ]),
      unique: expect.arrayContaining([
        expect.objectContaining({ field: "title", scope: "collection" }),
        expect.objectContaining({ field: "profile.display_name", scope: "type" })
      ]),
      path: expect.objectContaining({ pattern: "Contacts/{title}.md", folder: "Contacts" })
    });
    expect(next).toContain("runtime: example.paths");
    expect(next).toContain("projections:");
    expect(next).toContain("x-example:");
    expect(next).toContain("The Markdown body is documentation.");
  });

  it("removes collection rules and prunes empty containers", () => {
    let next = addTypeReadDefault(recursiveSource, "title", "");
    next = addTypeLinkRule(next, "title");
    next = addTypeUniqueRule(next, "title");
    next = removeTypeReadDefault(next, "title");
    next = removeTypeLinkRule(next, "title");
    next = removeTypeUniqueRule(next, 0);

    expect(next).not.toContain("collection:");
  });

  it("preserves spaces while editing a field description", () => {
    let next = recursiveSource;
    const title = readVisualType(next).fields.find((field) => field.name === "title")!;

    for (const character of "These are the tags for the notes.") {
      const current = readVisualType(next).fields.find((field) => field.name === "title")?.description ?? "";
      next = setTypeFieldDescription(next, title.path, current + character);
    }

    expect(readVisualType(next).fields.find((field) => field.name === "title")?.description)
      .toBe("These are the tags for the notes.");
  });

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

  it("classifies individual collection behaviour changes for review", () => {
    let next = updateTypeCollectionDisplay(recursiveSource, "name_field", "title");
    next = addTypeUniqueRule(next, "title");
    next = updateTypePathPolicy(next, "pattern", "People/{title}.md");

    expect(typeImpact(recursiveSource, next, [], "person").collectionChanges).toEqual([
      "Display metadata",
      "Uniqueness rules",
      "Path policy"
    ]);
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
    effectiveFrontmatter: structuredClone(frontmatter),
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
