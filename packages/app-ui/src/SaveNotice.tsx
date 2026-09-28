import type { JSX } from "react";

/**
 * saved: confirmed, so it settles away (see .mdbase-settle in controls.css).
 * saving: work in progress. pending: changed but not yet saved.
 * attention: a conflict or failure, which never fades.
 */
export type SaveTone = "saved" | "saving" | "pending" | "attention";

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
 */
export function SaveNotice({ tone, label = defaultLabels[tone], className }: {
  readonly tone: SaveTone;
  readonly label?: string;
  readonly className?: string;
}): JSX.Element {
  return <span
    className={["mdbase-save-notice", `is-${tone}`, tone === "saved" && "mdbase-settle", className].filter(Boolean).join(" ")}
    aria-live="polite"
  >
    {tone === "saved" && <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>}
    {label}
  </span>;
}
