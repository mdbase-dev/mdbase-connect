import { expect, type Locator } from "@playwright/test";

/** Replaces the body of the demo's opening note. That note embeds an image,
 * which settles only after the collection has resolved its link, and the editor
 * redraws as it does. A redraw between fill's select-all and its typing drops
 * the selection, so the text would be inserted instead of replacing the body. */
export async function replaceOpeningNoteBody(body: Locator, text: string): Promise<void> {
  await expect(body.locator(".cm-file-embed.ready")).toHaveCount(1);
  await body.fill(text);
}
