import type { NewNoteContext } from "./new-note";

/** The URL parameters a capture link or the share sheet fills: `?new=Title&text=…&url=…`. */
const captureParameters = ["new", "text", "url"] as const;

/** Longest title and body a capture may carry; the Editor shows all of it before it creates the note. */
export const CAPTURE_TITLE_LIMIT = 300;
export const CAPTURE_BODY_LIMIT = 10_000;

/** A capture is the note it prefills, or `too_long`: it is refused whole, never cut short. */
export type QuickCapture = NewNoteContext | "too_long";

/**
 * Takes a quick capture request from the page URL and removes it, so a reload or a later
 * collection switch does not open it again. The note is not created here: the Editor asks
 * before it opens a new note prefilled with it.
 */
export function takeQuickCapture(): QuickCapture | undefined {
  const url = new URL(location.href);
  if (!captureParameters.some((name) => url.searchParams.has(name))) return undefined;
  const capture = quickCapture(url.searchParams);
  for (const name of captureParameters) url.searchParams.delete(name);
  history.replaceState(history.state, "", url);
  return capture;
}

export function quickCapture(parameters: URLSearchParams): QuickCapture {
  const title = parameters.get("new")?.trim();
  const text = parameters.get("text")?.trim() ?? "";
  const link = parameters.get("url")?.trim() ?? "";
  // Share sheets often put the shared link in the text as well.
  const body = [text, link && !text.includes(link) ? link : ""].filter(Boolean).join("\n\n");
  if ((title?.length ?? 0) > CAPTURE_TITLE_LIMIT || body.length > CAPTURE_BODY_LIMIT) return "too_long";
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
}
