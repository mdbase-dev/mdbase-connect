import { expect, test, type Locator, type Page } from "@playwright/test";
import { replaceOpeningNoteBody } from "./note-body.js";

// CodeMirror places every line by the heights it holds for the blocks above
// it. Where a drawn block is taller on the page than CodeMirror thinks, each
// later line sits lower than its recorded place, and the arrows skip lines.

const tail = ["One", "Two", "Three", "Four"];

interface Placement { text: string; page: number; editor: number }

/** Where each line is on the page, and where the editor holds it to be. */
function placements(body: Locator): Promise<Placement[]> {
  return body.evaluate((content) => {
    const view = (content as unknown as { cmTile: { root: { view: {
      documentTop: number;
      posAtDOM(node: Node, offset: number): number;
      lineBlockAt(position: number): { top: number };
    } } } }).cmTile.root.view;
    return [...content.querySelectorAll(".cm-line")].map((line) => ({
      text: line.textContent ?? "",
      page: line.getBoundingClientRect().top,
      editor: view.lineBlockAt(view.posAtDOM(line, 0)).top + view.documentTop
    }));
  });
}

/** The lines after the block. The editor counts a table's own padding into the lines beside it, so those are not compared. */
async function expectLinesWhereTheEditorHoldsThem(body: Locator) {
  await expect.poll(async () => {
    const below = (await placements(body)).filter((line) => tail.includes(line.text));
    return below.length === tail.length ? Math.max(...below.map((line) => Math.abs(line.page - line.editor))) : Infinity;
  }).toBeLessThan(1);
}

function caretLine(body: Locator): Promise<string> {
  return body.evaluate((content) => {
    const { state } = (content as unknown as { cmTile: { root: { view: { state: {
      doc: { lineAt(position: number): { text: string } };
      selection: { main: { head: number } };
    } } } } }).cmTile.root.view;
    return state.doc.lineAt(state.selection.main.head).text;
  });
}

async function expectArrowsVisitEveryLine(page: Page, body: Locator) {
  await body.locator(".cm-line", { hasText: /^One$/ }).click();
  for (const text of tail.slice(1)) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => caretLine(body)).toBe(text);
  }
  for (const text of tail.slice(0, -1).reverse()) {
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => caretLine(body)).toBe(text);
  }
}

async function open(page: Page, block: string): Promise<Locator> {
  await page.goto("?demo=12");
  const body = page.getByRole("textbox", { name: "Note body" });
  await replaceOpeningNoteBody(body, "Before");
  await body.locator(".cm-line").first().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(`\n\n${block}\n\n${tail.join("\n")}`);
  await body.locator(".cm-line", { hasText: /^One$/ }).click();
  return body;
}

const drawn: Record<string, { source: string; settled: string }> = {
  "a diagram": { source: "```mermaid\nflowchart LR\n  A[Write] --> B[Read]\n```", settled: ".cm-lp-diagram svg" },
  "a display formula": { source: "$$\n\\int_0^1 x\\,dx\n$$", settled: ".cm-lp-math-block .katex-display" },
  "an image embed": { source: "![[Assets/frontmatter.svg]]", settled: ".cm-file-embed.ready img" },
  "a note embed": { source: "![[Journal/garden-notes-2]]", settled: ".cm-note-embed" },
  "a folded callout": { source: "> [!note]- Folded\n> Hidden one\n> Hidden two", settled: ".cm-lp-callout" },
  // A table is not a drawn block: its lines stay, laid out as rows.
  "a table": { source: "| Plant | Bed |\n| --- | --- |\n| Basil | North |", settled: ".cm-lp-table .cm-lp-td" }
};

for (const [name, { source, settled }] of Object.entries(drawn)) {
  test(`keeps the lines below ${name} where the editor holds them`, async ({ page }) => {
    const body = await open(page, source);
    await expect(body.locator(settled).first()).toBeVisible();
    await expectLinesWhereTheEditorHoldsThem(body);
    await expectArrowsVisitEveryLine(page, body);
  });
}

test("keeps the lines below a formula being edited where the editor holds them", async ({ page }) => {
  const body = await open(page, "$$\n\\int_0^1 x\\,dx\n$$");
  await body.locator(".cm-lp-math-block").click();
  await expect(body.locator(".cm-lp-math-preview .katex-display")).toBeVisible();
  await expectLinesWhereTheEditorHoldsThem(body);
  // From the formula's last line, down through the space below it.
  await page.keyboard.press("Control+End");
  for (const text of ["Three", "Two", "One", "", "$$"]) {
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => caretLine(body)).toBe(text);
  }
  for (const text of ["", "One", "Two"]) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => caretLine(body)).toBe(text);
  }
});

test("keeps the lines below a table being edited where the editor holds them", async ({ page }) => {
  const body = await open(page, "| Plant | Bed |\n| --- | --- |\n| Basil | North |");
  await body.locator(".cm-lp-td", { hasText: "Basil" }).click();
  await expect(body.locator(".cm-lp-td-active")).toHaveCount(1);
  await expectLinesWhereTheEditorHoldsThem(body);
});
