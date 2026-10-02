import { useEffect, useId, useRef, useState, type JSX } from "react";

import type { MdbaseAppId } from "./apps.js";

export type MdbaseMarkRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

/** Indeterminate waits. Each repeats until the motion is removed. */
export const mdbaseMarkLoops = [
  "orbit",
  "scan",
  "bounce",
  "stream",
  "sort",
  "hop"
] as const;

/** Played once when the mark appears; the mark then rests. */
export const mdbaseMarkEntrances = [
  "keys-first",
  "drop",
  "assemble"
] as const;

export const mdbaseMarkMotions = [...mdbaseMarkLoops, ...mdbaseMarkEntrances] as const;

export type MdbaseMarkLoop = typeof mdbaseMarkLoops[number];
type MdbaseMarkEntrance = typeof mdbaseMarkEntrances[number];
export type MdbaseMarkMotion = typeof mdbaseMarkMotions[number];
/** One-shot reactions to something the person did. */
export type MdbaseMarkSignalKind = "saved" | "error";

/** `id` changes for every occurrence, so the same kind can play twice in a row. */
export type MdbaseMarkSignal = Readonly<{ kind: MdbaseMarkSignalKind; id: number }>;

/** Long enough for each entrance in `motion.css` to finish. */
const ENTRANCE_MS = 1300;

export function mdbaseMarkMotionClass(motion?: MdbaseMarkMotion): string {
  return motion ? ` mdbase-motion-${motion}` : "";
}

function isEntrance(motion: MdbaseMarkMotion | undefined): motion is MdbaseMarkEntrance {
  return (mdbaseMarkEntrances as readonly string[]).includes(motion ?? "");
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

const lineYs = [22, 44, 66, 88] as const;
const orbitXs = [-34, -6, 22, 50, 78, 106] as const;

function classes(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

/** How much of each line is filled when `progress` of the whole is done, in reading order. */
export function mdbaseMarkLineFill(progress: number): number[] {
  const clamped = Math.min(1, Math.max(0, progress));
  return lineYs.map((_, line) => Math.min(1, Math.max(0, clamped * lineYs.length - line)));
}

function Segment({ rect, index, accent = false }: {
  rect: MdbaseMarkRect;
  index: number;
  accent?: boolean;
}): JSX.Element {
  return <rect
    className={`mdbase-mark-segment mdbase-mark-segment-${index} ${accent ? "mdbase-mark-accent" : "mdbase-mark-ink"}`}
    {...rect}
  />;
}

function Lines({ clipRows }: { clipRows?: string | undefined }): JSX.Element {
  const rows = <>
    <g className="mdbase-mark-row mdbase-mark-row-top">
      <Segment rect={mdbaseMarkInkRects[3]} index={4} />
      <Segment rect={mdbaseMarkAccentRect} index={5} accent />
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-bottom">
      <Segment rect={mdbaseMarkInkRects[4]} index={6} />
      <Segment rect={mdbaseMarkInkRects[5]} index={7} />
    </g>
  </>;
  return <>
    <g className="mdbase-mark-fence mdbase-mark-fence-top">
      {mdbaseMarkInkRects.slice(0, 3).map((rect, index) => <Segment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 1} />)}
    </g>
    {clipRows ? <g clipPath={`url(#${clipRows})`}>{rows}</g> : rows}
    <g className="mdbase-mark-fence mdbase-mark-fence-bottom">
      {mdbaseMarkInkRects.slice(6).map((rect, index) => <Segment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 8} />)}
    </g>
  </>;
}

/**
 * The Frontmatter mark. Without `app` it is the platform's own; with `app` it is
 * inverted, so the bars take the app's colour and the highlighted line stays ink.
 *
 * `motion` loops or plays an entrance, `signal` plays a one-shot reaction over
 * whatever else is running, and `progress` (0 to 1) fills the lines in reading
 * order over a faint copy of the mark. Animations live in `motion.css`.
 */
export function MdbaseMark({ app, motion, signal, progress, className }: {
  app?: MdbaseAppId | undefined;
  motion?: MdbaseMarkMotion | undefined;
  signal?: MdbaseMarkSignal | null | undefined;
  progress?: number | null | undefined;
  className?: string | undefined;
}): JSX.Element {
  const uid = useId().replaceAll(":", "");
  // An entrance plays once per mark. Dropping its class afterwards stops it replaying when a signal
  // remounts the lines, and remembering it stops a replay when a loop or progress hands back to it.
  const [entering, setEntering] = useState(isEntrance(motion));
  const played = useRef<MdbaseMarkMotion | undefined>(undefined);
  useEffect(() => {
    if (!isEntrance(motion) || played.current === motion) return setEntering(false);
    setEntering(true);
    const timer = setTimeout(() => {
      played.current = motion;
      setEntering(false);
    }, ENTRANCE_MS);
    return () => clearTimeout(timer);
  }, [motion]);

  const showsProgress = typeof progress === "number" && Number.isFinite(progress);
  const active = signal ? undefined
    : showsProgress ? undefined
    : isEntrance(motion) ? (entering ? motion : undefined)
    : motion;
  const lines = <Lines clipRows={active === "stream" ? `mdbase-rows-${uid}` : undefined} />;

  return <svg
    className={classes(
      "mdbase-mark",
      app && "mdbase-app-mark",
      app && `is-${app}`,
      className,
      active && `mdbase-motion-${active}`,
      signal && `mdbase-signal-${signal.kind}`,
      showsProgress && "mdbase-mark-progress",
      !active && !signal && !showsProgress && "mdbase-mark-at-rest"
    )}
    viewBox={MDBASE_MARK_VIEW_BOX}
    aria-hidden="true"
    focusable="false"
  >
    {active === "stream" && <defs>
      <clipPath id={`mdbase-rows-${uid}`}><rect x="22" y="40" width="76" height="40" /></clipPath>
    </defs>}
    {active === "orbit" && <defs>
      <clipPath id={`mdbase-fence-top-${uid}`}><rect x="22" y="22" width="76" height="10" /></clipPath>
      <clipPath id={`mdbase-fence-bottom-${uid}`}><rect x="22" y="88" width="76" height="10" /></clipPath>
    </defs>}
    {showsProgress
      ? <>
        <defs>
          <clipPath id={`mdbase-progress-${uid}`}>
            {mdbaseMarkLineFill(progress).map((fill, line) => <rect
              key={line}
              className="mdbase-mark-progress-fill"
              x="22"
              y={lineYs[line]! - 1}
              height="12"
              style={{ width: `${(76 * fill).toFixed(2)}px` }}
            />)}
          </clipPath>
        </defs>
        <g className="mdbase-mark-progress-ghost"><Lines /></g>
        <g clipPath={`url(#mdbase-progress-${uid})`}><Lines /></g>
      </>
      // Keyed by the signal so the same reaction can restart without replaying an entrance.
      : <g key={signal?.id ?? 0} className="mdbase-mark-lines">{lines}</g>}
    {active === "orbit" && <>
      <g clipPath={`url(#mdbase-fence-top-${uid})`}>
        <g className="mdbase-mark-track mdbase-mark-track-top">
          {orbitXs.map((x) => <rect key={x} x={x} y="22" width="20" height="10" />)}
        </g>
      </g>
      <g clipPath={`url(#mdbase-fence-bottom-${uid})`}>
        <g className="mdbase-mark-track mdbase-mark-track-bottom">
          {orbitXs.map((x) => <rect key={x} x={x} y="88" width="20" height="10" />)}
        </g>
      </g>
    </>}
  </svg>;
}

/** An app's mark. Kept for callers that only ever draw an app's still mark. */
export function MdbaseAppMark({ app, className }: {
  app: MdbaseAppId;
  className?: string;
}): JSX.Element {
  return <MdbaseMark app={app} className={className} />;
}

/**
 * `mdbase` followed by the product's quieter name. Editor carries the platform mark
 * as the canonical app; Reader and Writer carry their app marks.
 */
export function Wordmark({ app, motion, signal, progress }: {
  app: MdbaseAppId;
  motion?: MdbaseMarkMotion | undefined;
  signal?: MdbaseMarkSignal | null | undefined;
  progress?: number | null | undefined;
}): JSX.Element {
  return <span className="wordmark">
    <MdbaseMark
      app={app === "editor" ? undefined : app}
      motion={motion}
      signal={signal}
      progress={progress}
      className="wordmark-mark"
    />
    <span className="wordmark-label"><span>mdbase</span><strong>{app}</strong></span>
  </span>;
}
