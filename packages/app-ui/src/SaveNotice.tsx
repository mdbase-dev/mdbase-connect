import { useEffect, useRef, type JSX } from "react";

import type { MdbaseMarkSignalKind } from "./brand.js";
import { holdMdbaseMarkBusy, signalMdbaseMark } from "./mark-activity.js";

/**
 * saved: confirmed, so it settles away (see .mdbase-settle in controls.css).
 * saving: work in progress. pending: changed but not yet saved.
 * attention: a conflict or failure, which never fades.
 */
export type SaveTone = "saved" | "saving" | "pending" | "attention";

/** A save shorter than this never sets the mark moving. */
const SLOW_SAVE_MS = 600;

/** The mark's reaction when a notice changes from `before` to `tone`; none when it first appears. */
export function saveToneSignal(before: SaveTone | null, tone: SaveTone): MdbaseMarkSignalKind | null {
  if (before === null || before === tone) return null;
  if (tone === "attention") return "error";
  return tone === "saved" && (before === "saving" || before === "pending") ? "saved" : null;
}

const defaultLabels: Record<SaveTone, string> = {
  saved: "Saved",
  saving: "Saving",
  pending: "Unsaved",
  attention: "Needs attention"
};

/**
 * The minimal save notice every mdbase app shows beside what it edits. Put it inside an
 * element with `mdbase-settle-host` so hovering or focusing that element brings a settled
 * notice back.
 *
 * The notice also drives the app's mark: a save that completes plays `saved`, a newly
 * raised problem plays `error`, and a slow save bounces the mark until it ends.
 */
export function SaveNotice({ tone, label = defaultLabels[tone], className }: {
  readonly tone: SaveTone;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}): JSX.Element {
  const previous = useRef<SaveTone | null>(null);
  useEffect(() => {
    const kind = saveToneSignal(previous.current, tone);
    previous.current = tone;
    if (kind) signalMdbaseMark(kind);
  }, [tone]);
  useEffect(() => {
    if (tone !== "saving") return;
    let release: (() => void) | undefined;
    const timer = setTimeout(() => { release = holdMdbaseMarkBusy("bounce"); }, SLOW_SAVE_MS);
    return () => {
      clearTimeout(timer);
      release?.();
    };
  }, [tone]);
  return <span
    className={["mdbase-save-notice", `is-${tone}`, tone === "saved" && "mdbase-settle", className].filter(Boolean).join(" ")}
    aria-live="polite"
  >
    {tone === "saved" && <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>}
    {label}
  </span>;
}
