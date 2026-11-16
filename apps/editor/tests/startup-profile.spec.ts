import { devices, expect, test } from "@playwright/test";

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
      // The opening screen (painted by index.html, checked by first-contentful-paint below) is the
      // first paint. The workspace shell can commit together with its first rows, so it need only not trail them.
      expect(timing.marks.shell).toBeLessThanOrEqual(timing.marks.list);
      expect(timing.paints.find(({ name }) => name === "first-contentful-paint")?.ms).toBeLessThan(timing.marks.list);
      samples.push({ surface, run, ...timing, switches });
      await context.close();
    }
  }
  await testInfo.attach("production-profile", { body: JSON.stringify(samples, null, 2), contentType: "application/json" });
  console.log("EDITOR_PRODUCTION_PROFILE", JSON.stringify(samples));
});

// Time to first keystroke: from navigation to the frame that paints the first
// character typed into an existing note. Cold is a first visit (empty cache);
// warm revisits in the same browser profile, with the HTTP cache and the
// offline shell in place. The phone profile throttles the CPU four times.
test("profiles time to first keystroke on an existing note", { tag: "@performance" }, async ({ browser, baseURL }, testInfo) => {
  // Twenty visits, half at a throttled CPU, each first visit waiting for the offline shell.
  test.setTimeout(300_000);
  const profiles = [
    { name: "desktop", context: { viewport: { width: 1440, height: 900 } }, cpu: 1 },
    { name: "phone", context: { ...devices["Pixel 7"] }, cpu: 4 }
  ];
  const samples = [];
  for (const profile of profiles) {
    for (let run = 0; run < 5; run += 1) {
      const context = await browser.newContext(profile.context);
      const page = await context.newPage();
      await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: profile.cpu });
      await page.addInitScript(() => {
        const marks: Record<string, number> = {};
        const body = () => document.querySelector<HTMLElement>('.cm-content[aria-label="Note body"][contenteditable="true"]');
        new MutationObserver(() => {
          if (!marks.editable && body()?.textContent) marks.editable = performance.now();
        }).observe(document, { childList: true, subtree: true });
        // The keystroke is handled in its keydown task (as DOM input, or EditContext text on Android); its character paints on the next frame.
        document.addEventListener("keydown", (event) => {
          if (marks.keystroke || !body()?.contains(event.target as Node)) return;
          requestAnimationFrame(() => { marks.keystroke = performance.now(); });
        }, true);
        Object.assign(window, { firstKeystroke: marks });
      });
      for (const start of ["cold", "warm"]) {
        await page.goto(`${baseURL}?demo=300`);
        const body = page.getByRole("textbox", { name: "Note body", exact: true });
        await page.waitForFunction(() => (window as unknown as { firstKeystroke: Record<string, number> }).firstKeystroke.editable, undefined, { polling: "raf" });
        // A phone opens the note without the keyboard; the writer taps the text first.
        if (!await body.evaluate((element) => element === document.activeElement)) await body.locator(".cm-line").first().click();
        // Real key presses: a character off the keyboard layout would be inserted without any key events.
        await page.keyboard.type("Zq");
        await expect(body).toContainText("Zq");
        const marks = await page.waitForFunction(() => {
          const recorded = (window as unknown as { firstKeystroke: Record<string, number> }).firstKeystroke;
          return recorded.keystroke ? recorded : null;
        }, undefined, { polling: "raf" }).then((handle) => handle.jsonValue());
        expect(marks.editable).toBeLessThan(marks.keystroke);
        samples.push({ profile: profile.name, start, run, editableMs: Math.round(marks.editable), firstKeystrokeMs: Math.round(marks.keystroke) });
        // The offline shell installs once the note is usable; let it settle before the warm visit.
        if (start === "cold") await page.evaluate(() => navigator.serviceWorker?.ready.then(() => undefined));
      }
      await context.close();
    }
  }
  const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
  const summary = profiles.flatMap(({ name }) => ["cold", "warm"].map((start) => {
    const matching = samples.filter((sample) => sample.profile === name && sample.start === start);
    return { profile: name, start, editableMs: median(matching.map((sample) => sample.editableMs)), firstKeystrokeMs: median(matching.map((sample) => sample.firstKeystrokeMs)) };
  }));
  await testInfo.attach("first-keystroke", { body: JSON.stringify({ summary, samples }, null, 2), contentType: "application/json" });
  console.log("EDITOR_FIRST_KEYSTROKE", JSON.stringify(summary));
});
