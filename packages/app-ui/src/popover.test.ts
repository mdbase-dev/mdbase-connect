import { describe, expect, it } from "vitest";

import { anchoredPlacement } from "./popover.js";

describe("anchoredPlacement", () => {
  const viewport = { width: 800, height: 600 };
  const list = { width: 160, height: 200 };

  it("opens below when it fits, above when there is more room there", () => {
    expect(anchoredPlacement({ top: 100, bottom: 130, left: 20, width: 120 }, list, viewport).top).toBe(134);
    const nearBottom = anchoredPlacement({ top: 520, bottom: 550, left: 700, width: 120 }, list, viewport);
    expect(nearBottom.top).toBe(316);
    expect(nearBottom.left).toBe(632);
  });

  it("lines a menu up with the trigger's end edge", () => {
    const menu = { width: 320, height: 200 };
    const placement = anchoredPlacement({ top: 10, bottom: 40, left: 600, width: 80 }, menu, viewport, { gap: 6, align: "end" });
    expect(placement).toEqual({ top: 46, left: 360, maxHeight: 546 });
  });
});
