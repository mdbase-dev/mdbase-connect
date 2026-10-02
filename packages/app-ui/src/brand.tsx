import { useId, type JSX } from "react";

import type { MdbaseAppId } from "./apps.js";

export type MdbaseMarkRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export const mdbaseMarkMotions = [
  "bootstrap",
  "unfold",
  "rebalance",
  "conveyor"
] as const;

export type MdbaseMarkMotion = typeof mdbaseMarkMotions[number];

export function mdbaseMarkMotionClass(motion?: MdbaseMarkMotion): string {
  return motion ? ` mdbase-motion-${motion}` : "";
}

export const MDBASE_MARK_VIEW_BOX = "18 18 84 84";

export const mdbaseMarkInkRects = [
  { x: 22, y: 22, width: 20, height: 10 },
  { x: 50, y: 22, width: 20, height: 10 },
  { x: 78, y: 22, width: 20, height: 10 },
  { x: 22, y: 44, width: 12, height: 10 },
  { x: 22, y: 66, width: 28, height: 10 },
  { x: 58, y: 66, width: 40, height: 10 },
  { x: 22, y: 88, width: 20, height: 10 },
  { x: 50, y: 88, width: 20, height: 10 },
  { x: 78, y: 88, width: 20, height: 10 }
] as const satisfies readonly MdbaseMarkRect[];

export const mdbaseMarkAccentRect = {
  x: 42,
  y: 44,
  width: 56,
  height: 10
} as const satisfies MdbaseMarkRect;

const conveyorXs = [-6, 22, 50, 78, 106] as const;

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

function Segment({ rect, index, accent = false }: {
  rect: MdbaseMarkRect;
  index: number;
  accent?: boolean;
}): JSX.Element {
  return <rect
    className={`mdbase-mark-segment mdbase-mark-segment-${index} ${accent ? "mdbase-mark-accent" : "mdbase-mark-ink"}`}
    pathLength={1}
    {...rect}
  />;
}

/**
 * The platform's Frontmatter mark. Editor and Connect's own surfaces use it; the
 * segments and clipped conveyor exist so `motion.css` can animate the same SVG.
 */
export function MdbaseMark({ motion, className }: {
  motion?: MdbaseMarkMotion;
  className?: string;
}): JSX.Element {
  const clipId = `mdbase-fences-${useId().replaceAll(":", "")}`;
  return <svg
    className={classes("mdbase-mark", className) + mdbaseMarkMotionClass(motion)}
    viewBox={MDBASE_MARK_VIEW_BOX}
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <clipPath id={clipId}>
        <rect x="22" y="22" width="76" height="10" />
        <rect x="22" y="88" width="76" height="10" />
      </clipPath>
    </defs>
    <g className="mdbase-mark-fence mdbase-mark-fence-top">
      {mdbaseMarkInkRects.slice(0, 3).map((rect, index) => <Segment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 1} />)}
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-top">
      <Segment rect={mdbaseMarkInkRects[3]} index={4} />
      <Segment rect={mdbaseMarkAccentRect} index={5} accent />
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-bottom">
      <Segment rect={mdbaseMarkInkRects[4]} index={6} />
      <Segment rect={mdbaseMarkInkRects[5]} index={7} />
    </g>
    <g className="mdbase-mark-fence mdbase-mark-fence-bottom">
      {mdbaseMarkInkRects.slice(6).map((rect, index) => <Segment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 8} />)}
    </g>
    <g clipPath={`url(#${clipId})`}>
      <g className="mdbase-mark-conveyor-track">
        {conveyorXs.flatMap((x) => [22, 88].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="20" height="10" />))}
      </g>
    </g>
  </svg>;
}

/**
 * An app's mark: the platform mark inverted, so the bars take the app's colour and
 * the highlighted line stays ink. The plain mark stays the platform's own.
 */
export function MdbaseAppMark({ app, className }: {
  app: MdbaseAppId;
  className?: string;
}): JSX.Element {
  return <svg
    className={classes("mdbase-app-mark", `is-${app}`, className)}
    viewBox={MDBASE_MARK_VIEW_BOX}
    aria-hidden="true"
    focusable="false"
  >
    <g className="mdbase-app-mark-bars">
      {mdbaseMarkInkRects.map((rect) => <rect key={`${rect.x}-${rect.y}`} {...rect} />)}
    </g>
    <rect className="mdbase-app-mark-line" {...mdbaseMarkAccentRect} />
  </svg>;
}

/**
 * `mdbase` followed by the product's quieter name. Editor carries the platform mark
 * as the canonical app; Reader and Writer carry their app marks.
 */
export function Wordmark({ app, motion }: {
  app: MdbaseAppId;
  motion?: MdbaseMarkMotion;
}): JSX.Element {
  return <span className="wordmark">
    {app === "editor"
      ? <MdbaseMark motion={motion} className="wordmark-mark" />
      : <MdbaseAppMark app={app} className="wordmark-mark" />}
    <span className="wordmark-label"><span>mdbase</span><strong>{app}</strong></span>
  </span>;
}
