import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) test(`shortcut help columns align in ${colorScheme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("?demo=4");
  await expect(page.getByRole("listbox", { name: "Collection notes and files" })).toBeFocused();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Shortcuts", exact: true });
  await expect(help).toBeVisible();
  const navigate = await help.getByRole("heading", { name: "Navigate", exact: true }).boundingBox();
  const note = await help.getByRole("heading", { name: "Note", exact: true }).boundingBox();
  expect(Math.abs(navigate!.y - note!.y)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await help.locator(".shortcut-groups").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("first C captures every key while a cold composer chunk is delayed", async ({ page }, testInfo) => {
  await page.goto("?demo=300");
  await expect(page.locator(".title-input")).toBeVisible();
  const list = page.getByRole("listbox", { name: "Collection notes and files" });
  await expect(list).toBeFocused();
  const before = await list.evaluate(element => ({ cursor: element.getAttribute("aria-activedescendant"), scroll: element.scrollTop }));
  const delayedChunks: string[] = [];
  await page.route(/\/assets\/(NewNoteComposer|SelectionControls|StructuredPropertiesEditor)-.*\.js$/, async route => {
    delayedChunks.push(route.request().url());
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  const title = "Round seven jkjk probe";
  const started = Date.now();
  await page.keyboard.press("c");
  await page.keyboard.type(title, { delay: 40 });
  const input = page.getByRole("textbox", { name: "Title", exact: true });
  const captured = await input.count() ? await input.inputValue() : null;
  const after = await list.evaluate(element => ({ cursor: element.getAttribute("aria-activedescendant"), scroll: element.scrollTop }));
  await testInfo.attach("typing-measurement", { contentType: "application/json", body: JSON.stringify({ elapsedMs: Date.now() - started, typed: title.length, captured, delayedChunks, before, after }) });
  expect(captured).toBe(title);
  expect(after.scroll).toBe(before.scroll);
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".title-input")).toHaveValue(title);
  await expect(page.getByRole("button", { name: `${title}.md`, exact: true })).toBeVisible();
});

test("list undo and palette undo use the live toast, and vanish on dismissal", async ({ page }, testInfo) => {
  await page.goto("?demo=4");
  await expect(page.locator(".title-input")).toBeVisible();
  const list = page.getByRole("listbox", { name: "Collection notes and files" });
  const note = page.getByRole("option", { name: /The shape of useful tools/ });
  await expect(list).toBeFocused();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await expect(note).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(note).toHaveCount(1);
  await expect(list).toBeFocused();
  await expect(note).toHaveAttribute("aria-selected", "true");
  const keyboardRestored = await note.count() === 1;
  await page.keyboard.press("Control+Backspace");
  await expect(note).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const query = page.getByRole("combobox", { name: "Find a note or action" });
  await query.press("Control+a");
  await query.pressSequentially(">Undo", { delay: 40 });
  const undo = page.getByRole("option", { name: /^Undo/ });
  await expect(undo).toHaveCount(1);
  await testInfo.attach("undo-measurement", { contentType: "application/json", body: JSON.stringify({ keyboardRestored, paletteActions: await undo.count() }) });
  await page.keyboard.press("Enter");
  await expect(note).toHaveCount(1);
  await expect(list).toBeFocused();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.locator(".mdbase-toast").filter({ has: page.getByRole("button", { name: "Undo", exact: true }) }).getByRole("button", { name: "Dismiss", exact: true }).click();
  await list.focus();
  await page.keyboard.press("Control+z");
  await expect(note).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await query.press("Control+a");
  await query.pressSequentially(">Undo", { delay: 40 });
  await expect(undo).toHaveCount(0);
});

test("R and F2 rename the same path without stealing text input", async ({ page }, testInfo) => {
  await page.goto("?demo=4");
  await expect(page.locator(".title-input")).toBeVisible();
  const list = page.getByRole("listbox", { name: "Collection notes and files" });
  await expect(list).toBeFocused();
  const path = page.getByRole("textbox", { name: "Markdown path" });
  for (const key of ["r", "F2"]) {
    await page.keyboard.press(key);
    await expect(path).toHaveValue("Notes/the-shape-of-useful-tools.md");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("Notes/cancelled-rename.md", { delay: 40 });
    await page.keyboard.press("Escape");
    await expect(list).toBeFocused();
    await expect(page.getByRole("button", { name: "Notes/the-shape-of-useful-tools.md", exact: true })).toBeVisible();
  }
  await page.keyboard.press("/");
  const search = page.getByRole("combobox", { name: "Search notes and files" });
  await search.pressSequentially("research", { delay: 40 });
  await expect(search).toHaveValue("research");
  await expect(path).toHaveCount(0);
  await testInfo.attach("rename-measurement", { contentType: "application/json", body: JSON.stringify({ workingKeys: 2, typedCharacters: 8 }) });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`created row reuses remote-change-fade with ${reducedMotion} motion`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("?demo=4");
    await expect(page.locator(".title-input")).toBeVisible();
    await expect(page.locator(".note-scroll")).toBeFocused();
    await page.keyboard.press("c");
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeFocused();
    const title = "Arrival probe";
    await page.keyboard.type(title, { delay: 40 });
    await page.keyboard.press("Control+Enter");
    const row = page.getByRole("option", { name: /^Arrival probe/ });
    await expect(row).toBeVisible();
    const animation = await row.evaluate(element => ({ name: getComputedStyle(element).animationName, duration: getComputedStyle(element).animationDuration }));
    await testInfo.attach("arrival-measurement", { contentType: "application/json", body: JSON.stringify(animation) });
    expect(animation.name).toBe(reducedMotion === "reduce" ? "none" : "remote-change-fade");
    if (reducedMotion !== "reduce") {
      expect(animation.duration).toBe("0.9s");
    }
    await expect(row).not.toHaveClass(/note-row-arrival/);
  });

  test(`created row does not replay arrival after filtering in ${reducedMotion} motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("?demo=4");
    await expect(page.locator(".note-scroll")).toBeFocused();
    await page.keyboard.press("c");
    await page.keyboard.type("Arrival remount", { delay: 40 });
    await page.keyboard.press("Control+Enter");
    const row = page.getByRole("option", { name: /^Arrival remount/ });
    await expect(row).toHaveClass(/note-row-arrival/);
    await page.locator(".note-scroll").focus();
    await page.keyboard.press("/");
    const search = page.getByRole("combobox", { name: "Search notes and files" });
    await page.keyboard.type("zz", { delay: 40 });
    await expect(row).toHaveCount(0);
    await page.keyboard.type(" keep typing while the new row is hidden", { delay: 40 });
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(row).toBeVisible();
    expect(await row.getAttribute("class")).not.toMatch(/note-row-arrival/);
    expect(await row.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  });
}

test("file rows explain R and F2 without renaming the previous note", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.locator(".note-scroll")).toBeFocused();
  await page.keyboard.press("/");
  await page.keyboard.type("frontmatter.svg", { delay: 40 });
  const file = page.getByRole("option", { name: "frontmatter.svg, SVG file", exact: true });
  await expect(file).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await expect(file).toHaveAttribute("aria-selected", "true");
  for (const key of ["r", "F2"]) {
    await page.keyboard.press(key);
    await expect(page.getByText("Files can’t be renamed in the Editor.", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Markdown path" })).toHaveCount(0);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.locator(".note-scroll").focus();
  }
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Shortcuts", exact: true }).locator("dt").filter({ hasText: /^Rename$/ })).toHaveCount(0);
});

test("target icon buttons advertise their actual keyboard activation", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.locator(".title-input")).toBeVisible();
  const create = page.getByRole("button", { name: "New note", exact: true });
  const properties = page.getByRole("button", { name: "Note properties", exact: true });
  const actions = page.getByRole("button", { name: "More note actions", exact: true });
  await expect(create).toHaveAttribute("aria-keyshortcuts", "C Control+Shift+N Meta+Shift+N");
  await expect(properties).toHaveAttribute("aria-keyshortcuts", "Enter Space");
  await properties.focus();
  await page.keyboard.press("Enter");
  await expect(properties).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(properties).toHaveAttribute("aria-pressed", "false");
  await expect(actions).toHaveAttribute("aria-keyshortcuts", "Enter Space ArrowDown ArrowUp");
  await actions.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menu", { name: "More note actions", exact: true })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`phone skeleton matches title, excerpt and divider rhythm in ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await page.route("**/assets/*.js", route => route.abort());
    await page.goto("?demo=4");
    await page.keyboard.press("Tab");
    const opening = page.locator(".editor-opening");
    const skeleton = opening.locator(".opening-list-skeleton");
    const rows = skeleton.locator(":scope > div");
    await expect(rows).toHaveCount(6);
    const measurements = await rows.evaluateAll(elements => elements.map(element => ({ height: element.getBoundingClientRect().height, divider: getComputedStyle(element).borderBottomWidth, bars: [...element.children].map(child => child.getBoundingClientRect().height) })));
    await testInfo.attach("skeleton-measurement", { contentType: "application/json", body: JSON.stringify(measurements) });
    for (const row of measurements) {
      expect(row.height).toBe(76);
      expect(row.divider).toBe("1px");
      expect(row.bars).toHaveLength(3);
      expect(row.bars[0]).toBeCloseTo(16.9, 1);
      expect(row.bars[1]).toBeCloseTo(18.2, 1);
    }
    await expect(opening).not.toContainText("Reading its notes and types");
    expect(await opening.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    await opening.screenshot({ path: testInfo.outputPath(`skeleton-${colorScheme}.png`) });
  });
}

test("pin has no redundant Current note detail", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.locator(".title-input")).toBeVisible();
  await expect(page.locator(".note-scroll")).toBeFocused();
  await page.keyboard.press("Control+k");
  const query = page.getByRole("combobox", { name: "Find a note or action" });
  await query.press("Control+a");
  await query.pressSequentially(">Pin", { delay: 40 });
  const pin = page.getByRole("option", { name: /^Pin/ });
  await expect(pin).toHaveCount(1);
  await expect(pin).not.toContainText("Current note");
});

test("text undo stays native and an expired toast leaves no list undo", async ({ page }) => {
  await page.clock.install();
  await page.goto("?demo=4");
  const title = page.locator(".title-input");
  await expect(title).toBeVisible();
  const list = page.locator(".note-scroll");
  const deleted = page.getByRole("option", { name: /The shape of useful tools/ });
  await expect(list).toBeFocused();
  await page.keyboard.press("Control+Backspace");
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await expect(deleted).toHaveCount(0);
  const original = await title.inputValue();
  await title.focus();
  await page.keyboard.press("End");
  await page.keyboard.type("r", { delay: 40 });
  await expect(title).toHaveValue(`${original}r`);
  await page.keyboard.press("Control+z");
  await expect(title).toHaveValue(original);
  await expect(deleted).toHaveCount(0);
  await list.focus();
  await page.clock.fastForward(31_000);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(deleted).toHaveCount(0);
  await page.keyboard.press("Control+k");
  const query = page.getByRole("combobox", { name: "Find a note or action" });
  await query.press("Control+a");
  await query.pressSequentially(">Undo", { delay: 40 });
  await expect(page.getByRole("option", { name: /^Undo/ })).toHaveCount(0);
});
