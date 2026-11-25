import { useEffect, useId, useRef, useState, type JSX } from "react";

import type { MdbaseAppId, OfficialAppId } from "./apps.js";

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
let buildOwner: string | undefined;

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
  const [entering, setEntering] = useState(isEntrance(motion) && (motion !== "keys-first" || !buildOwner));
  const played = useRef<MdbaseMarkMotion | undefined>(undefined);
  useEffect(() => {
    if (!isEntrance(motion) || played.current === motion || (motion === "keys-first" && buildOwner !== undefined && buildOwner !== uid)) return setEntering(false);
    if (motion === "keys-first") buildOwner = uid;
    setEntering(true);
    const timer = setTimeout(() => {
      played.current = motion;
      setEntering(false);
    }, ENTRANCE_MS);
    return () => clearTimeout(timer);
  }, [motion, uid]);

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
  app: OfficialAppId;
  className?: string;
}): JSX.Element {
  if (app === "journal") {
    // One row of the Frontmatter mark: a single field and a line of writing.
    return <svg
      className={classes("mdbase-mark mdbase-app-mark is-journal", className)}
      viewBox={MDBASE_MARK_VIEW_BOX}
      aria-hidden="true"
      focusable="false"
    >
      <rect className="mdbase-mark-ink" x="22" y="55" width="12" height="10" />
      <rect className="mdbase-mark-accent" x="42" y="55" width="56" height="10" />
    </svg>;
  }
  if (app === "tasknotes") return <TaskNotesMark className={className} />;
  return <MdbaseMark app={app} className={className} />;
}

/** TaskNotes' own brush check (its `tasknotes-mark.svg`), in the app's colour. */
function TaskNotesMark({ className }: { className?: string | undefined }): JSX.Element {
  const mask = `tasknotes-mark-${useId().replaceAll(":", "")}`;
  return <svg
    className={classes("mdbase-mark mdbase-app-mark is-tasknotes", className)}
    viewBox="-5 -4 110 110"
    aria-hidden="true"
    focusable="false"
  >
    <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="101">
      <rect width="100" height="101" fill="white" />
      <path fill="black" d="m 5.9,52.4 -0.09,4.51 c 4.71,0.09 7.61,1.48 9.95,3.57 2.35,2.09 4.11,5.01 5.90,8.14 1.80,3.13 3.62,6.46 6.45,9.12 2.23,2.09 5.14,3.67 8.83,4.21 0.46,-1.51 1.05,-2.95 1.77,-4.33 -3.44,-0.21 -5.62,-1.39 -7.53,-3.17 -2.14,-2.01 -3.82,-4.92 -5.63,-8.08 -1.81,-3.16 -3.77,-6.56 -6.82,-9.27 -3.05,-2.71 -7.07,-4.59 -11.83,-4.70 z" />
      <path fill="black" d="M 73.6,18.3 69.9,20.9 c 4.06,5.75 4.40,11.33 2.77,16.78 -1.63,5.45 -5.41,10.67 -9.65,14.78 -8.49,8.20 -16.59,14.11 -21.83,21.18 -5.24,7.07 -7.22,15.59 -3.13,27.21 l 4.25,-1.50 c -3.74,-10.62 -2.11,-16.80 2.50,-23.01 4.61,-6.21 12.63,-12.19 21.34,-20.64 4.65,-4.50 8.89,-10.23 10.84,-16.72 1.95,-6.49 1.42,-13.86 -3.40,-20.68 z" />
    </mask>
    <path className="mdbase-mark-ink" mask={`url(#${mask})`} d="m 98.5,0.6 c -0.38,0 -0.83,0.09 -1.33,0.23 -2,0.59 -4.66,2.18 -5.78,3.22 -1.25,1.16 -4.16,4.93 -6.08,7.19 -2.67,3.12 -5.65,6.58 -9.32,11.13 2.58,5.61 2.61,11.38 1.05,16.60 -1.95,6.49 -6.19,12.22 -10.84,16.72 -8.71,8.43 -16.73,14.41 -21.34,20.64 -4.47,6.03 -6.13,12.03 -2.81,22.08 0.19,-0.23 0.37,-0.49 0.54,-0.80 10.57,-19.70 17.89,-27.30 41.9,-47.08 v 0 c 2.40,-1.97 3.71,-4.33 4.52,-7.14 0.81,-2.82 1.11,-6.10 1.52,-9.92 0.81,-7.64 2.02,-17.43 8.43,-29.95 0.37,-0.73 0.57,-1.30 0.62,-1.72 0.05,-0.43 -0.04,-0.71 -0.22,-0.90 -0.19,-0.18 -0.48,-0.27 -0.86,-0.26 z M 72.7,26.3 c -0.75,0.92 -1.51,1.84 -2.27,2.78 -9.09,11.05 -19.45,22.93 -28.54,29.97 -1.48,1.14 -2.98,1.54 -4.46,1.38 -1.49,-0.16 -2.97,-0.89 -4.43,-1.96 -2.91,-2.16 -5.74,-5.74 -8.35,-9.19 -2.62,-3.45 -5.04,-6.77 -7.12,-8.39 -1.04,-0.81 -1.99,-1.19 -2.83,-0.97 -0.84,0.22 -1.60,1.05 -2.26,2.70 -1.03,2.61 -1.60,6.22 -3.42,10.05 4.08,0.62 7.27,2.27 9.73,4.45 3.05,2.71 5.01,6.11 6.82,9.27 1.81,3.16 3.49,6.07 5.63,8.08 1.90,1.78 4.08,2.96 7.53,3.17 0.71,-1.37 1.55,-2.69 2.49,-3.95 5.24,-7.07 13.34,-12.98 21.83,-21.18 4.24,-4.11 8.02,-9.33 9.65,-14.78 1.12,-3.73 1.31,-7.53 0.01,-11.42 z M 10.3,49.1 c -0.09,0.29 -0.18,0.56 -0.28,0.85 0.10,-0.29 0.19,-0.56 0.28,-0.85 z m -4.02,7.84 c -0.01,0.01 -0.02,0.02 -0.03,0.03 0.01,-0.01 0.02,-0.02 0.03,-0.03 0,0 0,0 0,0 z m 0.12,0 c -1.08,1.40 -2.40,2.79 -4.05,4.12 -1.20,1.0 -1.85,1.86 -2.03,2.71 -0.18,0.85 0.10,1.67 0.76,2.53 1.32,1.71 4.16,3.54 7.81,5.91 7.28,4.73 17.75,11.63 25.63,24.16 0.64,1.02 1.74,2.04 2.95,2.65 -0.91,-5.36 -0.91,-8.78 -0.54,-11.88 -3.33,-0.55 -6.07,-2.12 -8.39,-4.72 -2.83,-3.17 -4.69,-6.59 -6.54,-9.85 -1.85,-3.26 -3.69,-6.37 -6.08,-8.47 -2.06,-1.81 -4.61,-3.0 -8.49,-3.17 z" />
  </svg>;
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
    <span className="wordmark-label"><span>mdbase</span>{" "}<strong>{app}</strong></span>
  </span>;
}
