import { describe, expect, it } from "vitest";
import type { CollectionChange } from "@mdbase-dev/connect";
import { structuralChangesRequireRefresh } from "./structural-change-reconciliation";

function change(type: string, payload: CollectionChange["payload"], cursor = 1): CollectionChange {
  return {
    cursor,
    type,
    occurred_at: "2026-08-03T00:00:00.000Z",
    payload
  };
}

describe("structuralChangesRequireRefresh", () => {
  it("accepts a locally reconciled create, delete, and rename", () => {
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.created", { path: "Created.md" })],
      new Set(["Created.md"])
    )).toBe(false);
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.deleted", { path: "Deleted.md" })],
      new Set()
    )).toBe(false);
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.renamed", { from: "Before.md", to: "After.md" })],
      new Set(["After.md"])
    )).toBe(false);
  });

  it("requests a refresh when the current index does not reflect an event", () => {
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.created", { path: "Remote.md" })],
      new Set()
    )).toBe(true);
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.deleted", { path: "Remote.md" })],
      new Set(["Remote.md"])
    )).toBe(true);
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.renamed", { from: "Before.md", to: "After.md" })],
      new Set(["Before.md"])
    )).toBe(true);
  });

  it("uses the final state of rapid delete/restore and rename-back sequences", () => {
    expect(structuralChangesRequireRefresh([
      change("mdbase.record.deleted", { path: "Note.md" }, 1),
      change("mdbase.record.created", { path: "Note.md" }, 2)
    ], new Set(["Note.md"]))).toBe(false);

    expect(structuralChangesRequireRefresh([
      change("mdbase.record.renamed", { from: "A.md", to: "B.md" }, 1),
      change("mdbase.record.renamed", { from: "B.md", to: "A.md" }, 2)
    ], new Set(["A.md"]))).toBe(false);
  });

  it("fails safe when a structural event is malformed", () => {
    expect(structuralChangesRequireRefresh(
      [change("mdbase.record.deleted", {})],
      new Set()
    )).toBe(true);
  });
});
