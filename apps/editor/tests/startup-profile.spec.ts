import { expect, test } from "@playwright/test";

test("profiles production first paint, note switching and Types", { tag: "@performance" }, async ({ browser, baseURL }, testInfo) => {
  const samples = [];
  for (const surface of ["notes", "types"]) {
    for (let run = 0; run < 5; run += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const marks: Record<string, number> = {};
        const longTasks: number[] = [];
        new PerformanceObserver((entries) => longTasks.push(...entries.getEntries().map(({ duration }) => duration))).observe({ type: "longtask", buffered: true });
        const observer = new MutationObserver(() => {
          for (const [name, selector] of [["shell", ".app-shell"], ["list", ".note-row, .type-row"], ["workspace", ".cm-content, .type-inspector input"]]) {
            if (!marks[name] && document.querySelector(selector)) marks[name] = performance.now();
          }
        });
        observer.observe(document, { childList: true, subtree: true });
        Object.assign(window, { editorProfile: { marks, longTasks } });
      });
      await page.goto(`${baseURL}?demo=300&surface=${surface}`);
      if (surface === "notes") await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeVisible();
      else await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
      const switches = [];
      if (surface === "notes") {
        for (let index = 1; index <= 5; index += 1) {
          const row = page.locator(".note-row:not(.file-row)").nth(index);
          const title = await row.locator(".note-title").innerText();
          switches.push(await row.evaluate(async (element, expected) => {
            const started = performance.now();
            (element as HTMLElement).click();
            while (document.querySelector<HTMLTextAreaElement>("#note-title")?.value !== expected || document.querySelector(".note-opening-status")) {
              if (performance.now() - started > 5000) throw new Error("Note switch did not finish");
              await new Promise(requestAnimationFrame);
            }
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            return performance.now() - started;
          }, title));
        }
      }
      const timing = await page.evaluate(() => ({
        ...(window as unknown as { editorProfile: { marks: Record<string, number>; longTasks: number[] } }).editorProfile,
        paints: performance.getEntriesByType("paint").map(({ name, startTime }) => ({ name, ms: startTime })),
        typesChunk: performance.getEntriesByType("resource").filter(({ name }) => /TypeBrowser-.*\.js$/.test(name))
          .map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration, bytes: (entry as PerformanceResourceTiming).transferSize }))
      }));
      expect(timing.marks.shell).toBeLessThan(timing.marks.list);
      expect(timing.paints.find(({ name }) => name === "first-contentful-paint")?.ms).toBeLessThan(timing.marks.list);
      samples.push({ surface, run, ...timing, switches });
      await context.close();
    }
  }
  await testInfo.attach("production-profile", { body: JSON.stringify(samples, null, 2), contentType: "application/json" });
  console.log("EDITOR_PRODUCTION_PROFILE", JSON.stringify(samples));
});
