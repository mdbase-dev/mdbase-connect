import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    catalog_version: 1,
    id: "mdbase.contracts",
    name: "mdbase contracts",
    description: "Published contract packs for mdbase collections.",
    homepage: "https://mdbase.dev/contracts/",
    publisher: {
      name: "mdbase",
      url: "https://mdbase.dev/"
    },
    contracts: [],
    packs: []
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })));
});

class ResizeObserverStub implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

globalThis.ResizeObserver = ResizeObserverStub;

const emptyRect = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({})
} as DOMRect);

Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = emptyRect;
