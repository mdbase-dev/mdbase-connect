import type { CSSProperties, JSX } from "react";

export type StatusGlyphState = "online" | "syncing" | "connecting" | "paused" | "offline" | "idle" | "attention";

/**
 * One drawing whose layers each state reveals, so states morph into each other.
 * The glyph is decoration beside a text label: `progress` (0 to 1) fills `syncing`.
 */
export function StatusGlyph({ state, progress }: { state: StatusGlyphState; progress?: number | undefined }): JSX.Element {
  const style = progress === undefined ? undefined : { "--status-remaining": 100 - progress * 100 } as CSSProperties;
  return <svg className="status-glyph" data-state={state} style={style} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
    <circle className="status-glyph-dot" cx="7" cy="7" r="4" />
    <circle className="status-glyph-ring" cx="7" cy="7" r="5.75" />
    <circle className="status-glyph-pie" cx="7" cy="7" r="3" pathLength="100" />
    <rect className="status-glyph-bar" x="4.75" y="4.5" width="1.5" height="5" />
    <rect className="status-glyph-bar" x="7.75" y="4.5" width="1.5" height="5" />
    <rect className="status-glyph-mark" x="6.25" y="3.5" width="1.5" height="4.5" />
    <rect className="status-glyph-mark" x="6.25" y="9" width="1.5" height="1.5" />
  </svg>;
}
