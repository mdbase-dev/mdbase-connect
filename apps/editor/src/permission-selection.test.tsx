import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { usePermissionSelection } from "@mdbase-dev/ui/permission-selection";

it("preserves a narrowed review across equivalent polling responses and ordering", () => {
  const { result, rerender } = renderHook(({ allowed }) => usePermissionSelection("grant", allowed), {
    initialProps: { allowed: ["read", "update", "delete"] }
  });
  act(() => result.current.setSelected(["read"]));
  rerender({ allowed: ["delete", "read", "update"] });
  expect(result.current.selected).toEqual(["read"]);
  expect(result.current.needsReview).toBe(false);
});

it("accepts acknowledgment of the permissions just saved without claiming an external change", () => {
  const { result, rerender } = renderHook(({ allowed }) => usePermissionSelection("grant", allowed), {
    initialProps: { allowed: ["read", "update"] }
  });
  act(() => result.current.setSelected(["read"]));
  rerender({ allowed: ["read"] });
  expect(result.current.selected).toEqual(["read"]);
  expect(result.current.needsReview).toBe(false);
});

it("requires a fresh review after a genuine conflicting change", () => {
  const { result, rerender } = renderHook(({ allowed }) => usePermissionSelection("grant", allowed), {
    initialProps: { allowed: ["read", "update"] }
  });
  act(() => result.current.setSelected(["read"]));
  rerender({ allowed: ["read", "delete"] });
  expect(result.current.selected).toEqual(["read", "delete"]);
  expect(result.current.needsReview).toBe(true);
  act(() => result.current.acknowledge());
  expect(result.current.needsReview).toBe(false);
});
