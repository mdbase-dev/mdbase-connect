import { describe, expect, it } from "vitest";
import { addTypeField, readVisualType, renameTypeField, setTypeFieldKind, setTypeFieldRequired, typeImpact } from "./type-schema";
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

  it("reports how a change affects currently indexed notes", () => {
    const next = setTypeFieldRequired(addTypeField(source), "field", true);
    const notes: NoteSummary[] = [
      { path: "one.md", frontmatter: { type: "task", title: "One" }, types: ["task"] },
      { path: "two.md", frontmatter: { type: "task", title: "Two", field: "present" }, types: ["task"] },
      { path: "other.md", frontmatter: {}, types: [] }
    ];

    expect(typeImpact(source, next, notes, "task")).toMatchObject({
      addedFields: ["field"],
      newlyRequired: ["field"],
      affectedNotes: 2,
      missingRequired: [{ field: "field", count: 1 }]
    });
  });
});
