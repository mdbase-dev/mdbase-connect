import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MdbaseMark,
  Wordmark,
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects,
  mdbaseMarkLineFill,
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
    expect(mdbaseMarkMotions).toEqual(["orbit", "scan", "bounce", "stream", "sort", "hop", "keys-first", "drop", "assemble"]);
    expect(mdbaseMarkMotionClass()).toBe("");
    expect(mdbaseMarkMotionClass("scan")).toBe(" mdbase-motion-scan");
  });

  it("fills the lines in reading order", () => {
    expect(mdbaseMarkLineFill(0)).toEqual([0, 0, 0, 0]);
    expect(mdbaseMarkLineFill(0.375)).toEqual([1, 0.5, 0, 0]);
    expect(mdbaseMarkLineFill(1)).toEqual([1, 1, 1, 1]);
    expect(mdbaseMarkLineFill(4)).toEqual([1, 1, 1, 1]);
  });
});

describe("marks", () => {
  it("renders every segment in one SVG and rests without a motion", () => {
    const markup = renderToStaticMarkup(<MdbaseMark className="size" />);

    expect(markup).toMatch(/^<svg class="mdbase-mark size mdbase-mark-at-rest"/);
    expect(markup.match(/mdbase-mark-segment /g)).toHaveLength(10);
    expect(markup).not.toContain("clipPath");
  });

  it("adds orbit's fence tracks and stream's row clip only when they run", () => {
    const orbit = renderToStaticMarkup(<MdbaseMark motion="orbit" />);
    expect(orbit).toContain("mdbase-motion-orbit");
    expect(orbit.match(/<rect x="-?\d+" y="(22|88)" width="20" height="10"><\/rect>/g)).toHaveLength(12);
    expect(renderToStaticMarkup(<MdbaseMark motion="stream" />)).toMatch(/<g clip-path="url\(#mdbase-rows-/);
  });

  it("plays an entrance from the first render", () => {
    expect(renderToStaticMarkup(<MdbaseMark motion="keys-first" />)).toContain("mdbase-motion-keys-first");
  });

  it("lets a signal or progress take over from a motion", () => {
    const saved = renderToStaticMarkup(<MdbaseMark motion="orbit" signal={{ kind: "saved", id: 3 }} />);
    expect(saved).toContain("mdbase-signal-saved");
    expect(saved).not.toContain("mdbase-motion-orbit");

    const progress = renderToStaticMarkup(<MdbaseMark motion="scan" progress={0.5} />);
    expect(progress).toContain("mdbase-mark-progress");
    expect(progress).not.toContain("mdbase-motion-scan");
    expect(progress).toContain("mdbase-mark-progress-ghost");
    expect(progress.match(/mdbase-mark-segment /g)).toHaveLength(20);
    expect(progress).toContain('style="width:76.00px"');
    expect(progress).toContain('style="width:0.00px"');
  });

  it("draws every bar with square corners", () => {
    expect(renderToStaticMarkup(<MdbaseMark motion="orbit" />)).not.toContain("rx=");
    expect(renderToStaticMarkup(<Wordmark app="writer" />)).not.toContain("rx=");
  });

  it("gives Editor the platform mark and other apps their own", () => {
    expect(renderToStaticMarkup(<Wordmark app="editor" />))
      .toContain('class="mdbase-mark wordmark-mark mdbase-mark-at-rest"');
    const reader = renderToStaticMarkup(<Wordmark app="reader" />);
    expect(reader).toContain('class="mdbase-mark mdbase-app-mark is-reader wordmark-mark mdbase-mark-at-rest"');
    expect(reader).toContain("<span>mdbase</span><strong>reader</strong>");
  });
});
