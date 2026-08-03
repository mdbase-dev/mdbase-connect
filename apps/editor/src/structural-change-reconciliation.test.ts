import { describe, expect, it } from "vitest";
import type { CollectionChange } from "@mdbase-dev/connect";
import { reconcileStructuralChanges } from "./structural-change-reconciliation";

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
    expect(reconcileStructuralChanges(
      [change("mdbase.record.created", { path: "Created.md" })],
      new Set(["Created.md"])
    )).toEqual({ requiresRefresh: false, deletedPathsToConfirm: [] });
    expect(reconcileStructuralChanges(
      [change("mdbase.record.deleted", { path: "Deleted.md" })],
      new Set()
    )).toEqual({ requiresRefresh: false, deletedPathsToConfirm: [] });
    expect(reconcileStructuralChanges(
      [change("mdbase.record.renamed", { from: "Before.md", to: "After.md" })],
      new Set(["After.md"])
    )).toEqual({ requiresRefresh: false, deletedPathsToConfirm: [] });
  });

  it("requests a refresh when the current index does not reflect an event", () => {
    expect(reconcileStructuralChanges(
      [change("mdbase.record.created", { path: "Remote.md" })],
      new Set()
    ).requiresRefresh).toBe(true);
    expect(reconcileStructuralChanges(
      [change("mdbase.record.renamed", { from: "Before.md", to: "After.md" })],
      new Set(["Before.md"])
    ).requiresRefresh).toBe(true);
  });

  it("targets a contradictory delete for authoritative confirmation", () => {
    expect(reconcileStructuralChanges(
      [change("mdbase.record.deleted", { path: "Remote.md" })],
      new Set(["Remote.md"])
    )).toEqual({ requiresRefresh: false, deletedPathsToConfirm: ["Remote.md"] });
  });

  it("uses the final state of rapid delete/restore and rename-back sequences", () => {
    expect(reconcileStructuralChanges([
      change("mdbase.record.deleted", { path: "Note.md" }, 1),
      change("mdbase.record.created", { path: "Note.md" }, 2)
    ], new Set(["Note.md"]))).toEqual({ requiresRefresh: false, deletedPathsToConfirm: [] });

    expect(reconcileStructuralChanges([
      change("mdbase.record.renamed", { from: "A.md", to: "B.md" }, 1),
      change("mdbase.record.renamed", { from: "B.md", to: "A.md" }, 2)
    ], new Set(["A.md"]))).toEqual({ requiresRefresh: false, deletedPathsToConfirm: [] });
  });

  it("fails safe when a structural event is malformed", () => {
    expect(reconcileStructuralChanges(
      [change("mdbase.record.deleted", {})],
      new Set()
    ).requiresRefresh).toBe(true);
  });
});
