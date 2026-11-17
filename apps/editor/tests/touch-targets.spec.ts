import { readFileSync } from "node:fs";
import { devices, expect, test } from "@playwright/test";

const { defaultBrowserType: _browser, ...phone } = devices["Pixel 7"];
test.use({ ...phone });

// The Editor bundles a released @mdbase-dev/ui; the workspace's stylesheets are applied on top so this checks the source.
const sourceCss = ["controls", "live-preview"].map((name) => readFileSync(new URL(`../../../packages/app-ui/css/${name}.css`, import.meta.url), "utf8").replace(/^@import.*$/gm, "")).join("\n");

const note = "Para above\n\n- [ ] A task\n\n| name | value |\n| - | - |\n| one | 1 |\n| two | 2 |\n\nAfter line\n\n```js\nconst a = 1;\n```\n\n> [!note]- Callout\n> body\n";

test("writing controls take a fingertip without covering the text around them", async ({ page }) => {
  await page.goto("?demo=300");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.addStyleTag({ content: sourceCss });
  await page.evaluate((doc) => {
    const view = (document.querySelector(".body-editor .cm-content") as unknown as { cmTile: { root: { view: import("@codemirror/view").EditorView } } }).cmTile.root.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: doc.indexOf("one") + 1 } });
    view.focus();
  }, note);
  await expect(page.locator(".cm-lp-table-controls-visible")).toHaveCount(1);
  const boxes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(
    ".cm-lp-table-controls > button, .cm-lp-code-header button, .cm-lp-callout-header button, .cm-lp-task"
  )].map((control) => {
    const visual = control.getBoundingClientRect();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (let x = Math.floor(visual.left) - 30; x <= visual.right + 30; x++) for (let y = Math.floor(visual.top) - 30; y <= visual.bottom + 30; y++) {
      if (!control.contains(document.elementFromPoint(x, y))) continue;
      left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
    }
    return [control.getAttribute("aria-label") ?? control.title, { visual: visual.toJSON() as DOMRect, hit: { left, right, top, bottom } }];
  })));
  expect(Object.keys(boxes).sort()).toEqual(["Add column", "Add row", "Column options", "Copy code", "Expand callout", "Mark task complete", "Row options"]);
  for (const [name, { visual, hit }] of Object.entries(boxes)) {
    // The row grip sits on the screen's left edge, which bounds its target.
    if (name !== "Row options" && name !== "Add column") expect(hit.right - hit.left, `${name} width`).toBeGreaterThanOrEqual(44);
    if (name !== "Add row") expect(hit.bottom - hit.top, `${name} height`).toBeGreaterThanOrEqual(44);
    if (name === "Row options") expect(hit.left, name).toBe(0);
    if (name === "Add column") expect(hit.right - hit.left, name).toBeGreaterThanOrEqual(Math.min(44, page.viewportSize()!.width - visual.left));
  }
  // Grips and add buttons grow away from the table, and Copy away from its code.
  expect(boxes["Column options"].hit.bottom).toBeLessThanOrEqual(Math.ceil(boxes["Column options"].visual.bottom));
  expect(boxes["Row options"].hit.right).toBeLessThanOrEqual(Math.ceil(boxes["Row options"].visual.right));
  expect(boxes["Add row"].hit.top).toBeGreaterThanOrEqual(Math.floor(boxes["Add row"].visual.top));
  expect(boxes["Add row"].hit.bottom - boxes["Add row"].hit.top).toBeGreaterThanOrEqual(44);
  expect(boxes["Add column"].hit.left).toBeGreaterThanOrEqual(Math.floor(boxes["Add column"].visual.left));
  expect(boxes["Copy code"].hit.bottom).toBeLessThanOrEqual(Math.ceil(boxes["Copy code"].visual.bottom));
});
