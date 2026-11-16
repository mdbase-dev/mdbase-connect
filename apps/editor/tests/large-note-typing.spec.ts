import { expect, test, type Page } from "@playwright/test";

/** About 50,000 words of everyday Markdown: headings, paragraphs with inline
 * marks and links, lists, tasks, quotes, code, a table and an image now and then. */
function largeNote(): string {
  const words = ["useful", "tools", "leave", "room", "for", "thought", "and", "the", "writer", "keeps", "a", "calm", "rhythm", "while", "notes", "grow", "into", "something", "larger"];
  const sentence = (seed: number, length = 14) => Array.from({ length }, (_, index) => words[(seed * 7 + index * 3) % words.length]).join(" ");
  const sections: string[] = [];
  for (let section = 0; sections.join("\n").split(/\s+/).length < 50_000; section += 1) {
    const lines = [`## Section ${section + 1}: ${sentence(section, 4)}`, ""];
    for (let paragraph = 0; paragraph < 3; paragraph += 1) {
      lines.push(`${sentence(section + paragraph)} with **${sentence(paragraph, 2)}**, *${sentence(section, 2)}*, \`code\` and [a link](https://example.com/${section}). See [[Notes/the-shape-of-useful-tools|The shape of useful tools]]. ${sentence(section * 3 + paragraph, 22)}.`, "");
    }
    lines.push(`- ${sentence(section, 6)}`, `- ${sentence(section + 1, 6)}`, `  - ${sentence(section + 2, 5)}`, `- [ ] ${sentence(section + 3, 4)}`, "");
    lines.push(`> ${sentence(section + 4, 12)}`, "");
    if (section % 4 === 0) lines.push("| Item | Count | Note |", "| --- | --- | --- |", ...Array.from({ length: 4 }, (_, row) => `| ${sentence(row, 2)} | ${row + section} | ${sentence(section + row, 3)} |`), "");
    if (section % 5 === 0) lines.push("```ts", `const section = ${section};`, "export function useful() { return section * 2; }", "```", "");
    if (section % 6 === 0) lines.push("![Frontmatter](../Assets/frontmatter.svg)", "");
    sections.push(lines.join("\n"));
  }
  return sections.join("\n");
}

const SMALL_NOTE = "## A small note\n\nOnly a few lines of text with **bold** and a [link](https://example.com).\n\n- one\n- two\n";

/** Replace the open note's body in one transaction, then put the caret at the end of the line holding `marker`. */
async function loadNote(page: Page, text: string, marker: string) {
  await page.evaluate(({ text, marker }) => {
    const content = document.querySelector<HTMLElement & { cmTile?: { root: { view: import("@codemirror/view").EditorView } } }>(".cm-content[aria-label='Note body']")!;
    const view = content.cmTile!.root.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    const at = view.state.doc.lineAt(text.indexOf(marker)).to;
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  }, { text, marker });
}

/** Keystroke latency: from the keydown event to the task after the frame that paints it. */
async function typingLatency(page: Page, keys: number): Promise<number[]> {
  await page.evaluate(() => {
    const samples: number[] = [];
    const channel = new MessageChannel();
    let pending: number | undefined;
    channel.port1.onmessage = () => {
      if (pending !== undefined) samples.push(performance.now() - pending);
      pending = undefined;
    };
    document.addEventListener("keydown", (event) => {
      pending = event.timeStamp;
      requestAnimationFrame(() => channel.port2.postMessage(null));
    }, true);
    Object.assign(window, { typingSamples: samples });
  });
  for (let key = 0; key < keys; key += 1) {
    await page.keyboard.press(key % 6 === 5 ? "Space" : "KeyX");
    // Let the keystroke paint and any idle work run before the next, so each is measured alone.
    await page.waitForFunction((count) => (window as unknown as { typingSamples: number[] }).typingSamples.length > count, key, { polling: "raf" });
    await page.waitForTimeout(150);
  }
  return page.evaluate(() => (window as unknown as { typingSamples: number[] }).typingSamples);
}

const percentile = (values: number[], fraction: number) => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))];

// Trace snapshots run on every key press and would be measured with it.
test.use({ trace: "off" });

// Typing in a 50,000-word note against a small one, at full speed and with the
// CPU throttled four times. Each keystroke is measured from its keydown to the
// task after the frame that paints it. Draft recovery's browser-storage writes
// on each keystroke are timed separately.
test("profiles typing latency in a large note", { tag: "@performance" }, async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(300_000);
  const large = largeNote();
  const summary = [];
  for (const cpu of [1, 4]) {
    for (const [name, text, marker] of [["small", SMALL_NOTE, "Only a few"], ["large", large, "## Section 120:"]] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const storage: number[] = [];
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          const started = performance.now();
          try { return setItem.call(this, key, value); } finally { if (key.startsWith("mdbase-editor:draft")) storage.push(performance.now() - started); }
        };
        Object.assign(window, { draftWrites: storage });
      });
      await page.goto(`${baseURL}?demo=10`);
      const body = page.getByRole("textbox", { name: "Note body", exact: true });
      await expect(body).toBeVisible();
      await loadNote(page, text, marker);
      await page.waitForTimeout(1_000);
      await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: cpu });
      const samples = await typingLatency(page, 30);
      const draft = await page.evaluate(() => {
        const writes = (window as unknown as { draftWrites: number[] }).draftWrites;
        const value = Object.keys(localStorage).filter((key) => key.startsWith("mdbase-editor:draft")).map((key) => localStorage.getItem(key)!.length)[0] ?? 0;
        const parsed = Object.keys(localStorage).filter((key) => key.startsWith("mdbase-editor:draft")).map((key) => JSON.parse(localStorage.getItem(key)!))[0];
        const started = performance.now();
        for (let run = 0; run < 10; run += 1) JSON.stringify({ ...parsed, savedAt: run });
        return { writes: writes.length, setItemMs: writes.length ? writes.reduce((sum, ms) => sum + ms, 0) / writes.length : 0, stringifyMs: (performance.now() - started) / 10, bytes: value };
      });
      summary.push({
        cpu, note: name, characters: text.length, keys: samples.length,
        p50: Math.round(percentile(samples, 0.5)), p95: Math.round(percentile(samples, 0.95)),
        draftWriteMs: Math.round((draft.setItemMs + draft.stringifyMs) * 10) / 10, draftWrites: draft.writes, draftBytes: draft.bytes
      });
      await context.close();
    }
  }
  await testInfo.attach("large-note-typing", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
  console.log("EDITOR_LARGE_NOTE_TYPING", JSON.stringify(summary));
});
