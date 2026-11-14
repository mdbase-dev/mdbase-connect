import type { NewNoteContext } from "./new-note";

/** The URL parameters a capture link or the share sheet fills: `?new=Title&text=…&url=…`. */
const captureParameters = ["new", "text", "url"] as const;

/**
 * Takes a quick capture request from the page URL and removes it, so a reload or a later
 * collection switch does not open it again. The note is not created here: the Editor asks
 * before it opens a new note prefilled with it.
 */
export function takeQuickCapture(): NewNoteContext | undefined {
  const url = new URL(location.href);
  if (!captureParameters.some((name) => url.searchParams.has(name))) return undefined;
  const capture = quickCapture(url.searchParams);
  for (const name of captureParameters) url.searchParams.delete(name);
  history.replaceState(history.state, "", url);
  return capture;
}

export function quickCapture(parameters: URLSearchParams): NewNoteContext {
  const title = parameters.get("new")?.trim();
  const text = parameters.get("text")?.trim() ?? "";
  const link = parameters.get("url")?.trim() ?? "";
  // Share sheets often put the shared link in the text as well.
  const body = [text, link && !text.includes(link) ? link : ""].filter(Boolean).join("\n\n");
  return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
}
