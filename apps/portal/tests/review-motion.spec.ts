import type { Page } from "@playwright/test";
import { expect, openScenario, test } from "./review/fixture";

async function observe(page: Page, selector: string) {
  await page.evaluate(selector => {
    const frames: { time: number; height: number; opacity: number; connected: boolean; animations: { property: string; duration: number | string }[] }[] = [];
    const element = document.querySelector<HTMLElement>(selector)!;
    const started = performance.now();
    const sample = () => {
      frames.push({ time: performance.now() - started, height: element.getBoundingClientRect().height,
        opacity: Number(getComputedStyle(element).opacity), connected: element.isConnected,
        animations: element.getAnimations({ subtree: true }).map(animation => ({
          property: animation instanceof CSSTransition ? animation.transitionProperty : animation.id,
          duration: animation.effect!.getTiming().duration
        })) });
      if (frames.at(-1)!.time < 450) requestAnimationFrame(sample);
    };
    Object.assign(window, { motionFrames: frames });
    requestAnimationFrame(sample);
  }, selector);
}

async function frames(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { motionFrames: { time: number }[] }).motionFrames.at(-1)?.time)).toBeGreaterThanOrEqual(450);
  return page.evaluate(() => (window as unknown as { motionFrames: { time: number; height: number; opacity: number; connected: boolean; animations: { property: string; duration: number | string }[] }[] }).motionFrames);
}

test("built palette exits and reopens continuously, and results resize in stable steps", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openScenario(page, "heavy-account");
  await page.getByRole("button", { name: /^Search/ }).click();
  const palette = page.getByRole("dialog", { name: "Commands", exact: true });
  await palette.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await observe(page, "dialog.mdbase-command-palette");
  const interruption = await page.evaluate(async () => {
    const dialog = document.querySelector<HTMLDialogElement>("dialog.mdbase-command-palette")!;
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const leaving = await new Promise<number>((resolve, reject) => {
      const started = performance.now();
      const sample = () => {
        const opacity = Number(getComputedStyle(dialog).opacity);
        if (dialog.dataset.open === "false" && opacity > 0 && opacity < 1) resolve(opacity);
        else if (performance.now() - started > 1_000) reject(new Error("Palette exit did not expose an intermediate frame"));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { leaving, same: document.querySelector("dialog.mdbase-command-palette") === dialog, open: dialog.dataset.open };
  });
  expect(interruption.same).toBe(true);
  expect(interruption.open).toBe("true");
  expect(interruption.leaving).toBeLessThan(1);
  await expect(palette).toHaveCSS("opacity", "1");
  const interrupted = await frames(page);
  const query = palette.getByRole("combobox");
  await observe(page, ".mdbase-command-results");
  await query.fill("Sign out");
  const resized = await frames(page);
  expect(resized.some(frame => frame.animations.some(animation => animation.property === "height" && animation.duration === 160))).toBe(true);
  expect(new Set(resized.map(frame => frame.height)).size).toBeGreaterThan(2);
  await expect(query).toHaveAttribute("aria-activedescendant", (await palette.getByRole("option", { selected: true }).getAttribute("id"))!);
  await query.fill("Nothing matches this command");
  await expect(palette.getByRole("status")).toBeVisible();
  await expect(palette.locator(".mdbase-command-results")).toHaveCSS("height", "152px");
  await observe(page, "dialog.mdbase-command-palette");
  await page.keyboard.press("Escape");
  const exit = await frames(page);
  expect(exit.some(frame => frame.animations.some(animation => animation.duration === 120))).toBe(true);
  expect(exit.filter(frame => frame.connected).at(-1)!.time).toBeGreaterThanOrEqual(90);
  expect(exit.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  await testInfo.attach("palette-motion", { body: JSON.stringify({ interruption, interrupted, resized, exit }, null, 2), contentType: "application/json" });
});

test("Connected fixture glyphs change only on confirmed readback in 200ms", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openScenario(page, "computer-connected");
  const row = page.locator(".connect-collection-row").filter({ has: page.getByRole("link", { name: "Field research", exact: true }) });
  await expect(row.locator('.status-glyph[data-state="online"]')).toBeVisible();
  await page.route("**/v1/me", async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.connectors[0].last_seen_at = "2026-10-30T08:20:00.000Z";
    await route.fulfill({ response, json: data });
  });
  await observe(page, '.connect-collection-row:has(a[href*="collection-0"]) .status-glyph');
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row.locator('.status-glyph[data-state="offline"]')).toBeVisible();
  const samples = await frames(page);
  expect(samples.some(frame => frame.animations.some(animation => animation.duration === 200))).toBe(true);
  await testInfo.attach("status-motion", { body: JSON.stringify(samples, null, 2), contentType: "application/json" });
});

test("disclosures open and close at 160ms on the built bundle", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openScenario(page, "applications");
  const disclosure = page.locator("details.mdbase-disclosure").first();
  await observe(page, "details.mdbase-disclosure");
  await disclosure.locator(":scope > summary").click();
  const enter = await frames(page);
  expect(await disclosure.evaluate(element => getComputedStyle(element, "::details-content").transitionDuration)).toBe("0.16s, 0.16s");
  expect(new Set(enter.map(frame => frame.height)).size).toBeGreaterThan(2);
  await observe(page, "details.mdbase-disclosure");
  await disclosure.locator(":scope > summary").click();
  const exit = await frames(page);
  expect(new Set(exit.map(frame => frame.height)).size).toBeGreaterThan(2);
  await testInfo.attach("disclosure-motion", { body: JSON.stringify({ enter, exit }, null, 2), contentType: "application/json" });
});

test("grant identity and countdown follow confirmed approval in both motion modes", async ({ page }) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await openScenario(page, "authorization-setting-up");
    await expect(page.locator(".grant-moment")).toHaveCount(0);
    await openScenario(page, "authorization-return");
    await expect(page.locator(".grant-moment .request-identity-mark")).toHaveText("T");
    await expect(page.locator(".grant-collection-glyph svg")).toBeVisible();
    await expect(page.locator(".request-return-countdown")).toHaveText("3 seconds");
    await expect(page.getByRole("link", { name: "Return to TaskNotes", exact: true })).toBeVisible();
    await expect(page.locator(".request-return-countdown")).toHaveText("2 seconds");
    await expect(page).toHaveURL(/\/__review\/return$/);
  }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test(`new rows, stacked receipts and press feedback: ${reducedMotion}`, async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion });
  await openScenario(page, "typical-account");
  const washes = [];
  for (const name of ["First motion collection", "Second motion collection"]) {
    await page.getByRole("button", { name: "Add collection", exact: true }).click();
    await page.getByRole("button", { name: /^Hosted by mdbase/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add collection", exact: true });
    await dialog.getByRole("textbox", { name: "Collection name" }).fill(name);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const row = page.locator(".connect-collection-row.is-new").filter({ has: page.getByRole("link", { name, exact: true }) });
    await expect(row).toBeVisible();
    const wash = await row.evaluate(element => ({
      opacity: Number(getComputedStyle(element, "::before").opacity),
      durations: element.getAnimations({ subtree: true }).map(animation => animation.effect!.getTiming().duration),
      transition: getComputedStyle(element, "::before").transitionDuration
    }));
    washes.push(wash);
    if (reducedMotion === "reduce") { expect(wash.opacity).toBe(1); expect(wash.durations).toEqual([]); }
    else { expect(wash.durations).toContain(1000); expect(wash.transition).toBe("1s"); }
  }
  await expect(page.locator('.mdbase-toast-slot[data-open="true"]')).toHaveCount(2);
  await page.locator(".mdbase-toaster").hover();
  const first = page.locator(".mdbase-toast-slot").first();
  await first.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await observe(page, ".mdbase-toaster");
  await first.getByRole("button", { name: "Dismiss" }).click();
  const reflow = await frames(page);
  if (reducedMotion === "no-preference") {
    expect(reflow.some(frame => frame.animations.some(animation => animation.property === "grid-template-rows" && animation.duration === 120))).toBe(true);
    expect(new Set(reflow.map(frame => frame.height)).size).toBeGreaterThan(2);
  } else expect(reflow.every(frame => frame.animations.length === 0)).toBe(true);
  await expect(page.locator(".mdbase-toast-slot")).toHaveCount(1);
  const button = page.getByRole("button", { name: "Add collection", exact: true });
  await button.hover();
  await page.mouse.down();
  const press = await button.evaluate(async element => {
    await new Promise(requestAnimationFrame);
    return { transform: getComputedStyle(element).transform, transitions: element.getAnimations().map(animation => ({ property: animation instanceof CSSTransition ? animation.transitionProperty : animation.id, duration: animation.effect!.getTiming().duration })) };
  });
  expect(press.transitions.some(animation => animation.property === "transform")).toBe(false);
  expect(press.transform).toBe(reducedMotion === "reduce" ? "none" : "matrix(0.97, 0, 0, 0.97, 0, 0)");
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await testInfo.attach("creation-receipt-press-motion", { body: JSON.stringify({ washes, reflow, press }, null, 2), contentType: "application/json" });
});
