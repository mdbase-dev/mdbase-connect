import { describe, expect, it } from "vitest";
import type { TasknotesContract } from "@mdbase/tasknotes";
import {
  editableTaskFields,
  missingRequiredFields,
  requiredCreateFields,
  taskFieldPatch,
  taskFieldValue
} from "./taskFields";

const fields = [
  {
    key: "due_on",
    role: "due",
    label: "Due",
    kind: "date",
    required: false,
    readOnly: false,
    schema: {}
  },
  {
    key: "estimate",
    label: "Effort",
    kind: "integer",
    required: true,
    readOnly: false,
    schema: {}
  },
  {
    key: "reviewed",
    label: "Reviewed",
    kind: "boolean",
    required: false,
    readOnly: false,
    schema: {}
  },
  {
    key: "labels",
    label: "Labels",
    kind: "list",
    itemKind: "text",
    required: false,
    readOnly: false,
    schema: {}
  },
  {
    key: "time_entries",
    role: "timeEntries",
    label: "Time entries",
    kind: "list",
    itemKind: "unsupported",
    required: false,
    readOnly: false,
    schema: {}
  }
] satisfies TasknotesContract["fields"];

const contract = { fields } as TasknotesContract;

describe("TaskNotes schema field forms", () => {
  it("selects safe custom and common core fields", () => {
    expect(editableTaskFields(contract).map((field) => field.key)).toEqual([
      "due_on",
      "estimate",
      "reviewed",
      "labels"
    ]);
    expect(requiredCreateFields(contract).map((field) => field.key)).toEqual(["estimate"]);
  });

  it("reads and serializes supported schema values", () => {
    expect(taskFieldValue({ labels: ["work", "home"] }, fields[3])).toBe("work, home");
    expect(taskFieldPatch(fields.slice(0, 4), {
      due_on: "",
      estimate: "45",
      reviewed: true,
      labels: "work, home"
    })).toEqual({
      due_on: null,
      estimate: 45,
      reviewed: true,
      labels: ["work", "home"]
    });
  });

  it("validates required and numeric values before sending a patch", () => {
    expect(missingRequiredFields([fields[1]], { estimate: "" })).toEqual(["Effort"]);
    expect(() => taskFieldPatch([fields[1]], { estimate: "4.5" }))
      .toThrow("Effort must be a valid integer.");
  });
});
