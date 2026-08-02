import {
  MDBASE_MARK_VIEW_BOX,
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects,
  mdbaseMarkMotionClass,
  type MdbaseMarkMotion,
  type MdbaseMarkRect
} from "@mdbase/connect-ui/brand";
import { useId } from "react";

const conveyorXs = [-6, 22, 50, 78, 106] as const;

function Segment({ rect, index, accent = false }: {
  rect: MdbaseMarkRect;
  index: number;
  accent?: boolean;
}) {
  return <rect
    className={`mdbase-mark-segment mdbase-mark-segment-${index} ${accent ? "mdbase-mark-accent wordmark-mark-accent" : "mdbase-mark-ink"}`}
    pathLength={1}
    {...rect}
  />;
}

export function MdbaseMark({ motion }: { motion?: MdbaseMarkMotion }) {
  const clipId = `mdbase-fences-${useId().replaceAll(":", "")}`;
  return <svg
    className={`wordmark-mark mdbase-motion-mark${mdbaseMarkMotionClass(motion)}`}
    viewBox={MDBASE_MARK_VIEW_BOX}
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <clipPath id={clipId}>
        <rect x="22" y="22" width="76" height="10" rx="2" />
        <rect x="22" y="88" width="76" height="10" rx="2" />
      </clipPath>
    </defs>
    <g className="mdbase-mark-fence mdbase-mark-fence-top wordmark-mark-ink">
      {mdbaseMarkInkRects.slice(0, 3).map((rect, index) => <Segment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 1} />)}
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-top">
      <Segment rect={mdbaseMarkInkRects[3]} index={4} />
      <Segment rect={mdbaseMarkAccentRect} index={5} accent />
    </g>
    <g className="mdbase-mark-row mdbase-mark-row-bottom wordmark-mark-ink">
      <Segment rect={mdbaseMarkInkRects[4]} index={6} />
      <Segment rect={mdbaseMarkInkRects[5]} index={7} />
    </g>
    <g className="mdbase-mark-fence mdbase-mark-fence-bottom wordmark-mark-ink">
      {mdbaseMarkInkRects.slice(6).map((rect, index) => <Segment key={`${rect.x}-${rect.y}`} rect={rect} index={index + 8} />)}
    </g>
    <g clipPath={`url(#${clipId})`}>
      <g className="mdbase-mark-conveyor-track">
        {conveyorXs.flatMap((x) => [22, 88].map((y) => <rect key={`${x}-${y}`} x={x} y={y} width="20" height="10" rx="2" />))}
      </g>
    </g>
  </svg>;
}

export function Wordmark({ motion }: { motion?: MdbaseMarkMotion }) {
  return <div className="wordmark"><MdbaseMark motion={motion} /><span className="wordmark-label"><span>mdbase</span><strong>editor</strong></span></div>;
}
