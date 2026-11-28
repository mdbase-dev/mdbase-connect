import { expect, test, type Page } from "@playwright/test";

type Milestone = { selector: string; text?: string; value?: string };
type ProfileWindow = Window & { workspaceTiming: Promise<Record<string, number>> };

// Sample in Chromium from the input event to the first frame with the expected
// content, excluding Playwright's actionability checks and assertion polling.
async function sample(page: Page, action: () => Promise<void>, milestones: Record<string, Milestone>, event = "click") {
  await page.evaluate(({ event, milestones }) => {
    (window as ProfileWindow).workspaceTiming = new Promise((resolve, reject) => {
      document.addEventListener(event, () => {
        const start = performance.now();
        const pending = new Map(Object.entries(milestones));
        const done: Record<string, number> = {};
        function frame() {
          const elapsed = performance.now() - start;
          for (const [name, { selector, text, value }] of pending) {
            const observed = [...document.querySelectorAll<HTMLInputElement>(selector)].some(element =>
              (text === undefined || element.textContent?.includes(text)) && (value === undefined || element.value === value));
            if (observed) {
              pending.delete(name);
              done[name] = elapsed;
            }
          }
          if (!pending.size) resolve(done);
          else if (elapsed > 5000) reject(new Error(`Waiting for ${[...pending.keys()].join(", ")}`));
          else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
  }, { event, milestones });
  await action();
  return page.evaluate(() => (window as ProfileWindow).workspaceTiming);
}

test("profiles the 10k workspace", { tag: "@performance" }, async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const samples: Record<string, number>[] = [];
  for (let run = 0; run < 7; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const page = await context.newPage();
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(`${baseURL}?demo=10000`);
      const title = page.getByRole("textbox", { name: "Note title", exact: true });
      const openingTitle = "The shape of useful tools";
      await expect(title).toHaveValue(openingTitle);
      await expect(page.locator(".list-header p")).toContainText("10,001 notes");
      const allNotes = page.getByRole("button", { name: /^All notes,/ });
      const archive = page.locator('[data-folder-path="Archive"]');
      const linkedFrom = page.getByRole("region", { name: "Linked from" });
      const back = linkedFrom.getByRole("button", { name: /Garden notes 2/ });
      await expect(back).toBeAttached();

      const folder = await sample(page, () => archive.click(), { folder: { selector: ".list-header p", text: "2,000 notes" } });
      const returnToAll = await sample(page, () => allNotes.click(), { returnToAll: { selector: ".list-header p", text: "10,001 notes" } });
      await page.getByRole("option").filter({ hasText: "Garden notes 2" }).click();
      await expect(title).toHaveValue("Garden notes 2");
      const outgoingLink = page.locator(".body-editor .cm-line").filter({ hasText: openingTitle });
      const links = await sample(page, () => outgoingLink.click({ modifiers: ["Control"] }), {
        outgoing: { selector: "#note-title", value: openingTitle },
        backlinks: { selector: '.linked-from[aria-busy="false"] button', text: "Garden notes 2" }
      });

      await page.getByRole("option").filter({ hasText: "Ideas for Sunday 12" }).click();
      await expect(title).toHaveValue("Ideas for Sunday 12");
      const propertiesButton = page.getByRole("button", { name: "Note properties", exact: true });
      const properties = await sample(page, () => propertiesButton.click(), { properties: { selector: ".property-fields", text: "ideas" } });
      const panel = page.getByRole("complementary", { name: "Note properties" });
      const tag = panel.getByRole("textbox", { name: "tags", exact: true });
      await tag.fill("workspace-profile");
      const edit = await sample(page, () => tag.press("Enter"), { edit: { selector: '.property-fields button[aria-label="Remove workspace-profile"]' } }, "keydown");
      await panel.getByRole("button", { name: "Close properties" }).click();
      await expect(page.getByRole("main", { name: "Note editor" })).toHaveAttribute("data-save-state", "saved");
      const filters = page.getByRole("button", { name: "Search filters" });
      const tags = await sample(page, () => filters.click(), { tags: { selector: "#note-filter-suggestions [role=option]", text: "#workspace-profile" } });
      await expect(page.getByRole("listbox", { name: "Search filters" }).getByRole("option", { name: "#workspace-profile 1" })).toBeVisible();
      samples.push({ ...folder, ...returnToAll, ...links, ...properties, ...edit, ...tags });
    } finally {
      await context.close();
    }
  }
  const medians = Object.fromEntries(Object.keys(samples[0]).map(key => [
    key, Number(samples.map(sample => sample[key]).sort((left, right) => left - right)[3].toFixed(1))
  ]));
  await testInfo.attach("workspace-profile", { body: JSON.stringify({ medians, samples }, null, 2), contentType: "application/json" });
  console.log("EDITOR_10K_WORKSPACE", JSON.stringify({ medians, samples }));
});
