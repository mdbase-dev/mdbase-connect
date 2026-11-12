import { expect, type Locator } from "@playwright/test";

/** Waits for the demo's opening note to settle. That note embeds an image,
 * which settles only after the collection has resolved its link, and the editor
 * redraws as it does: the embed's text changes from "Opening …" to its actions. */
export async function openingNoteSettled(body: Locator): Promise<void> {
  await expect(body.locator(".cm-file-embed.ready")).toHaveCount(1);
}

/** Replaces the body of the demo's opening note once it has settled. A redraw
 * between fill's select-all and its typing drops the selection, so the text
 * would be inserted instead of replacing the body. */
export async function replaceOpeningNoteBody(body: Locator, text: string): Promise<void> {
  await openingNoteSettled(body);
  await body.fill(text);
}
