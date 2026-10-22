import { describe, expect, it } from "vitest";

import { FLOCK_TIMING, flockBarClosed, flockBars, flockBirds, flockFrame } from "./flock.js";

const stage = { width: 1440, height: 900, markLeft: 672, markTop: 380, markSize: 96 };
const scale = stage.markSize / 84;

describe("launch flock", () => {
  it("gives every bar birds whose cells tile it exactly", () => {
    flockBars.forEach(({ rect }, bar) => {
      const cells = flockBirds.filter((bird) => bird.bar === bar).map((bird) => bird.cell);
      const area = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
      expect(area).toBeCloseTo(rect.width * rect.height, 6);
      for (const cell of cells) {
        expect(cell.x).toBeGreaterThanOrEqual(rect.x - 1e-9);
        expect(cell.x + cell.width).toBeLessThanOrEqual(rect.x + rect.width + 1e-9);
      }
    });
  });

  it("starts every bird off screen", () => {
    const { birds } = flockFrame(stage, 0);
    expect(birds).toHaveLength(flockBirds.length);
    for (const bird of birds) {
      const inside = bird.x + bird.width > 0 && bird.x < stage.width && bird.y + bird.height > 0 && bird.y < stage.height;
      expect(inside).toBe(false);
    }
  });

  it("closes every bar by the time the mark is solid", () => {
    flockBars.forEach((_, bar) => expect(flockBarClosed(bar, FLOCK_TIMING.solid)).toBe(1));
    expect(flockBarClosed(flockBars.findIndex((bar) => bar.accent), FLOCK_TIMING.close + FLOCK_TIMING.closeDuration)).toBeLessThan(1);
  });

  it("ends on exactly the mark's rectangles", () => {
    const { birds, bars } = flockFrame(stage, FLOCK_TIMING.solid);
    expect(birds).toHaveLength(0);
    expect(bars).toEqual(flockBars.map(({ rect, accent }) => ({
      x: stage.markLeft + (rect.x - 18) * scale,
      y: stage.markTop + (rect.y - 18) * scale,
      width: rect.width * scale,
      height: rect.height * scale,
      accent
    })));
  });
});
