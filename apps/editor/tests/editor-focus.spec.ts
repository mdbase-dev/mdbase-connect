import { expect, test } from "@playwright/test";

test("a delayed CodeEditor chunk does not steal sidebar search typing", async ({ page }) => {
  let releaseChunk!: () => void;
  const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });
  let chunkRequested!: () => void;
  const requested = new Promise<void>((resolve) => { chunkRequested = resolve; });
  await page.route(/\/assets\/CodeEditor-[^/]+\.js$/, async (route) => {
    chunkRequested();
    await chunkGate;
    await route.continue();
  });
  try {
    await page.goto("?demo=12", { waitUntil: "domcontentloaded" });
    const search = page.getByRole("combobox", { name: "Search notes and files" });
    await search.focus();
    await requested;
    await expect(search).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toHaveCount(0);
    releaseChunk();
    const body = page.getByRole("textbox", { name: "Note body", exact: true });
    await expect(body).toBeVisible();
    // Asset loading legitimately replaces its status with a caption/actions.
    // Compare the settled document, not “Opening…” against the ready widget.
    await expect(page.getByRole("img", { name: "A durable piece of frontmatter" })).toBeVisible();
    await expect(page.locator(".cm-file-embed")).toHaveClass(/ready/);
    const originalBody = await body.innerText();
    // Cross the mount's autofocus frame before typing, without refocusing search.
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(search).toBeFocused();
    await page.keyboard.type("Record 4 remains lightweight");
    await expect(search).toHaveValue("Record 4 remains lightweight");
    await expect(body).toHaveText(originalBody, { useInnerText: true });
    await expect(page.getByRole("option", { name: /Reading list 4/ }).locator(".note-search-context"))
      .toContainText("Record 4 remains lightweight");
  } finally {
    releaseChunk();
  }
});
