import assert from "node:assert/strict";
import test from "node:test";
import {
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects,
  type MdbaseMarkRect
} from "./brand.ts";

test("keeps the Frontmatter mark on its selected square grid", () => {
  const rects: readonly MdbaseMarkRect[] = [
    ...mdbaseMarkInkRects,
    mdbaseMarkAccentRect
  ];
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const rows = [...new Set(rects.map((rect) => rect.y))].sort((a, b) => a - b);

  assert.deepEqual([right - left, bottom - top], [76, 76]);
  assert.deepEqual([...new Set(rects.map((rect) => rect.height))], [10]);
  assert.deepEqual(rows.slice(1).map((row, index) => row - rows[index]), [22, 22, 22]);
});

test("keeps key and fence proportions aligned", () => {
  const dash = mdbaseMarkInkRects[0];
  const firstKey = mdbaseMarkInkRects[3];
  const secondKey = mdbaseMarkInkRects[4];
  const gap = mdbaseMarkAccentRect.x - (firstKey.x + firstKey.width);

  assert.equal(firstKey.width + gap, dash.width);
  assert.equal(secondKey.width, dash.width + gap);
});
