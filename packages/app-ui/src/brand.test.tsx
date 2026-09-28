import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MdbaseMark,
  Wordmark,
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects,
  mdbaseMarkMotionClass,
  mdbaseMarkMotions,
  type MdbaseMarkRect
} from "./brand.js";

describe("Frontmatter mark geometry", () => {
  it("keeps the mark on its square grid", () => {
    const rects: readonly MdbaseMarkRect[] = [...mdbaseMarkInkRects, mdbaseMarkAccentRect];
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    const rows = [...new Set(rects.map((rect) => rect.y))].sort((a, b) => a - b);

    expect([right - left, bottom - top]).toEqual([76, 76]);
    expect([...new Set(rects.map((rect) => rect.height))]).toEqual([10]);
    expect(rows.slice(1).map((row, index) => row - rows[index]!)).toEqual([22, 22, 22]);
  });

  it("keeps key and fence proportions aligned", () => {
    const dash = mdbaseMarkInkRects[0];
    const firstKey = mdbaseMarkInkRects[3];
    const secondKey = mdbaseMarkInkRects[4];
    const gap = mdbaseMarkAccentRect.x - (firstKey.x + firstKey.width);

    expect(firstKey.width + gap).toBe(dash.width);
    expect(secondKey.width).toBe(dash.width + gap);
  });

  it("exposes only the adopted motion vocabulary", () => {
    expect(mdbaseMarkMotions).toEqual(["bootstrap", "unfold", "rebalance", "conveyor"]);
    expect(mdbaseMarkMotionClass()).toBe("");
    expect(mdbaseMarkMotionClass("rebalance")).toBe(" mdbase-motion-rebalance");
  });
});

describe("marks", () => {
  it("renders every segment and the clipped conveyor in one SVG", () => {
    const markup = renderToStaticMarkup(<MdbaseMark motion="bootstrap" className="size" />);

    expect(markup).toMatch(/^<svg class="mdbase-mark size mdbase-motion-bootstrap"/);
    expect(markup.match(/mdbase-mark-segment /g)).toHaveLength(10);
    expect(markup.match(/<rect x="-?\d+" y="(22|88)" width="20"/g)).toHaveLength(10);
  });

  it("gives Editor the platform mark and other apps their own", () => {
    expect(renderToStaticMarkup(<Wordmark app="editor" />))
      .toContain('class="mdbase-mark wordmark-mark"');
    const reader = renderToStaticMarkup(<Wordmark app="reader" />);
    expect(reader).toContain('class="mdbase-app-mark is-reader wordmark-mark"');
    expect(reader).toContain("<span>mdbase</span><strong>reader</strong>");
  });
});
