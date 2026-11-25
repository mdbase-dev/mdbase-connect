import { describe, expect, it } from "vitest";

import { anchoredPlacement, submenuPlacement } from "./popover.js";

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

describe("submenuPlacement", () => {
  const viewport = { width: 800, height: 600 };
  const submenu = { width: 240, height: 160 };
  const row = { top: 300, bottom: 348, left: 20, width: 290 };

  it("opens after the parent menu, level with its row", () => {
    expect(submenuPlacement(row, { left: 15, width: 300 }, submenu, viewport)).toEqual({ side: "after", left: 319, top: 295 });
  });

  it("opens before the parent menu when there is no room after it", () => {
    expect(submenuPlacement({ ...row, left: 500 }, { left: 495, width: 300 }, submenu, viewport)).toEqual({ side: "before", left: 251, top: 295 });
  });

  it("overlaps the parent below its row on a narrow screen, inside the viewport", () => {
    const phone = { width: 390, height: 600 };
    expect(submenuPlacement({ ...row, top: 500, bottom: 548 }, { left: 15, width: 300 }, submenu, phone)).toEqual({ side: "below", left: 20, top: 432 });
  });
});
