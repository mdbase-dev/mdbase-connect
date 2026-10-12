// @vitest-environment node
import type { Mdbase } from "@mdbase-dev/sdk";
import { JSDOM } from "jsdom";
import { act } from "react";
import { afterAll, expect, it } from "vitest";

import { shareTestDocument } from "./testing.js";

it("lets a Node test render the gate and move focus with one shared window", async () => {
  const restore = shareTestDocument(new JSDOM("<!doctype html><body></body>").window);
  afterAll(restore);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const { CollectionGate } = await import("../collections.js");
  let snapshot = {
    status: "starting", signIn: null, collections: [], selection: { requested: { collectionId: null, displayName: null } },
    readiness: { checking: false, assessment: null, problem: null, facets: {} }, links: null, phase: { kind: "starting" },
  };
  const listeners = new Set<() => void>();
  const entry = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    start: () => new Promise(() => {}),
  } as unknown as Mdbase;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  act(() => root.render(<CollectionGate mdbase={entry} app={{ name: "Reader" }}>{() => null}</CollectionGate>));
  snapshot = { ...snapshot, status: "signed_out", phase: { kind: "signed_out", notice: null } as never };
  act(() => { for (const listener of listeners) listener(); });
  expect(document.activeElement?.tagName).toBe("H1");
  act(() => root.unmount());
});
