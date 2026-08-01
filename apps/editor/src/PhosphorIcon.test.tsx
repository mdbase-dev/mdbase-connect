import { render } from "@testing-library/react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it } from "vitest";
import {
  collectionTypeIcon,
  isPhosphorIconName,
  normalizePhosphorIconName,
  PhosphorIcon
} from "./PhosphorIcon";

describe("Phosphor icons", () => {
  it("normalizes canonical, component, namespaced, and legacy names", () => {
    expect(normalizePhosphorIconName("BookOpen")).toBe("book-open");
    expect(normalizePhosphorIconName("phosphor:book-open")).toBe("book-open");
    expect(normalizePhosphorIconName("notebook-pen")).toBe("notebook");
    expect(isPhosphorIconName("BookOpen")).toBe(true);
    expect(isPhosphorIconName("not-a-real-icon")).toBe(false);
  });

  it("reads display icons from normalized and portable type definitions", () => {
    expect(collectionTypeIcon(typeDescriptor({ display: { icon: "notebook" } }))).toBe("notebook");
    expect(collectionTypeIcon({
      ...typeDescriptor(),
      definition: { collection: { display: { icon: "book-open" } } }
    })).toBe("book-open");
  });

  it("renders only known icons", () => {
    const { container, rerender } = render(<PhosphorIcon name="BookOpen" aria-hidden="true" />);
    expect(container.querySelector(".ph-book-open")).toBeInTheDocument();
    rerender(<PhosphorIcon name="not-a-real-icon" aria-hidden="true" />);
    expect(container).toBeEmptyDOMElement();
  });
});

function typeDescriptor(collection?: CollectionTypeDescriptor["collection"]): CollectionTypeDescriptor {
  return {
    name: "note",
    schema: {},
    collection,
    extensions: {}
  };
}
