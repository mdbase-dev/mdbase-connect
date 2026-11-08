import { expect, openScenario, test } from "./review/fixture";
import { authorizationId, pairingId } from "./review/scenarios.mjs";
import type { Page, TestInfo } from "@playwright/test";

test("W35 approved access names the next step without figurative copy", async ({ page }) => {
  await openScenario(page, "authorization-approved");
  await page.keyboard.press("Tab");
  const outcome = page.locator(".request-outcome");
  await expect(outcome).not.toContainText("will follow you back");
  await expect(outcome).toContainText("Continue in TaskNotes to use this collection.");
});

test("W28 Retry keeps keyboard focus and ignores activation during a background refresh", async ({ page }) => {
  let requests = 0;
  let finish: (() => void) | undefined;
  await page.route(url => url.pathname === "/v1/me", async route => {
    if (++requests > 1) await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ status: 503, json: { error: { message: "Diagnostic" } } });
  });
  await page.goto("/__review/scenario/typical-account?latency=60");
  const alert = page.getByRole("alert");
  const retry = alert.getByRole("button", { name: "Try again" });
  await expect(retry).toHaveAttribute("aria-disabled", "false");
  await retry.focus();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(retry).toHaveAttribute("aria-disabled", "true");
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  expect(requests).toBe(2);
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish!();
  await expect(retry).toHaveAttribute("aria-disabled", "false");
  await expect(retry).toBeFocused();
  await expect(alert).toContainText("Something went wrong on mdbase. Try again.");
});

test("W28 post-approval inspection redirects a 401 without replaying approval", async ({ page }) => {
  await openScenario(page, "pairing-many");
  await page.getByRole("option").first().click();
  const original = page.url();
  let approvals = 0;
  await page.route(url => url.pathname === "/v1/me", route => route.fulfill({ status: 401, json: { error: { message: "Sign in" } } }));
  await page.route(`**/v1/pairing-requests/${pairingId}**`, async route => {
    if (route.request().method() === "POST" && route.request().url().endsWith("/approve")) approvals++;
    if (route.request().method() === "GET" && approvals) return route.fulfill({ status: 401, json: { error: { message: "Sign in" } } });
    await route.continue();
  });
  await page.getByRole("button", { name: "Open Reader", exact: true }).click();
  await expect(page).toHaveURL(new URL(`/login?return_to=${encodeURIComponent(original)}`, original).href);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(approvals).toBe(1);
});

test("W28 Cancel keeps keyboard focus on the approval target while denial is pending", async ({ page }) => {
  await openScenario(page, "pairing-many");
  await page.getByRole("option").first().click();
  let finish: (() => void) | undefined;
  await page.route(`**/v1/pairing-requests/${pairingId}/deny`, async route => {
    await new Promise<void>(resolve => { finish = resolve; });
    await route.continue();
  });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await cancel.press("Enter");
  await expect(cancel).toBeDisabled();
  await expect(page.locator(".approval-target")).toBeFocused();
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish!();
  await expect(page.getByRole("heading", { name: "Sign-in cancelled" })).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) test(`W28 focus, palette, Rename and pairing ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme });
    await openScenario(page, "heavy-account");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    await expect(palette).toBeVisible();
    await palette.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const height = (await palette.locator(".mdbase-command-results").boundingBox())!.height;
    expect(height).toBeGreaterThanOrEqual(380);
    await palette.getByRole("combobox").fill("a");
    expect((await palette.locator(".mdbase-command-results").boundingBox())!.height).toBeLessThanOrEqual(height);
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    const columns = await help.locator("dd").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
    expect(new Set(columns).size).toBe(1);
    const helpImage = testInfo.outputPath("help-alignment.png");
    await page.screenshot({ path: helpImage });
    await testInfo.attach("help-alignment", { path: helpImage, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    const row = page.locator('[data-command="collection:hosted-0"]');
    const collectionName = await row.locator(".connect-collection-name strong").innerText();
    await row.locator(".connect-collection-link").focus();
    await page.keyboard.press("Control+k");
    const rename = palette.getByRole("option", { name: new RegExp(`^Rename ${collectionName}`) });
    await palette.getByRole("combobox").fill(`Rename ${collectionName}`);
    await expect(rename).toBeVisible();
    await expect(rename.locator("kbd")).toHaveText("R");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await row.locator(".connect-collection-link").focus();
    await page.keyboard.press("r");
    const renameDialog = page.getByRole("dialog", { name: `Rename ${collectionName}`, exact: true });
    await expect(renameDialog.getByRole("textbox")).toBeFocused();
    await renameDialog.getByRole("textbox").fill("");
    await renameDialog.getByRole("textbox").press("r");
    await expect(renameDialog.getByRole("textbox")).toHaveValue("r");
    await page.keyboard.press("Escape");

    await openScenario(page, "typical-account");
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    const app = page.locator('[data-command="app:app-1"]');
    await app.locator(":scope > summary").click();
    await app.getByRole("button", { name: "Revoke app", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Revoke Reader?" });
    let finish: (() => void) | undefined;
    let fail = true;
    await page.route("**/v1/**", async route => {
      if (route.request().method() !== "POST" || !route.request().url().endsWith("/v1/grants/revoke-batch")) return route.continue();
      await new Promise<void>(resolve => { finish = resolve; });
      if (fail) return route.fulfill({ status: 500, json: { error: { code: "internal_error", message: "Internal error" } } });
      return route.continue();
    });
    await confirmation.getByRole("button", { name: "Revoke app", exact: true }).click();
    await expect(confirmation.getByRole("button", { name: "Revoking access…", exact: true })).toBeDisabled();
    await expect.poll(() => Boolean(finish)).toBe(true);
    for (const key of ["Tab", "Shift+Tab", "Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    const pendingImage = testInfo.outputPath("pending-confirmation.png");
    await page.screenshot({ path: pendingImage });
    await testInfo.attach("pending-confirmation", { path: pendingImage, contentType: "image/png" });
    finish!();
    await expect(confirmation.getByRole("alert")).toHaveText("Something went wrong on mdbase. Try again.");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    fail = false;
    finish = undefined;
    await confirmation.getByRole("button", { name: "Revoke app", exact: true }).click();
    await expect(confirmation.getByRole("button", { name: "Revoking access…", exact: true })).toBeDisabled();
    await expect.poll(() => Boolean(finish)).toBe(true);
    finish!();
    await expect(confirmation).toHaveCount(0);
    await expect(app).toHaveCount(0);
    await expect(page.locator(".connect-main :focus")).toBeVisible();
    await page.unroute("**/v1/**");

    await openScenario(page, "pairing-many");
    await page.getByRole("combobox", { name: "Open in Reader", exact: true }).fill("Field");
    const choice = page.getByRole("option", { name: /^Field research/ }).first();
    const chosenName = (await choice.getAttribute("aria-label"))!;
    await choice.click();
    let readback!: () => void;
    let approved = false;
    await page.route(`**/v1/pairing-requests/${pairingId}**`, async route => {
      if (route.request().method() === "POST" && route.request().url().endsWith("/approve")) approved = true;
      if (route.request().method() === "GET" && approved) await new Promise<void>(resolve => { readback = resolve; });
      return route.continue();
    });
    await page.getByRole("button", { name: /^Open Reader(?: with .+)?$/ }).press("Enter");
    await expect.poll(() => Boolean(readback)).toBe(true);
    await expect(page.getByText("Loading the request…", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    readback();
    await expect(page.getByRole("heading", { name: `Reader can now use ${chosenName}`, exact: true })).toBeFocused();
    await expect(page.getByRole("heading", { name: `Reader can now use ${chosenName}`, exact: true })).toHaveCSS("outline-style", "none");
    await page.locator(".grant-moment").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const approvedImage = testInfo.outputPath("pairing-approved.png");
    await page.screenshot({ path: approvedImage });
    await testInfo.attach("pairing-approved", { path: approvedImage, contentType: "image/png" });
  });

}


async function checkConsentFocus(page: Page, testInfo: TestInfo) {
  const controls = await page.locator(".authorization-panel").evaluate(panel => {
    const controls = [...panel.querySelectorAll<HTMLElement>("a[href], button, input, select, summary, [tabindex], .collection-picker-list")]
      .filter(element => (element.tabIndex >= 0 || (element.matches(".collection-picker-list") && element.scrollHeight > element.clientHeight))
        && !element.matches(":disabled") && element.checkVisibility());
    controls.forEach((element, index) => { element.dataset.reviewFocusIndex = String(index); });
    controls[0].focus();
    return controls.length;
  });
  const visited = [];
  for (let index = 0; index < controls; index++) {
    const focus = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement;
      const bounds = active.getBoundingClientRect();
      const footer = document.querySelector(".approval-footer")!.getBoundingClientRect();
      return { index: Number(active.dataset.reviewFocusIndex), tag: active.tagName, name: active.getAttribute("aria-label") ?? active.textContent?.slice(0, 80),
        clear: Boolean(active.closest(".approval-footer")) || bounds.bottom <= footer.top,
        hit: active.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)) };
    });
    visited.push(focus);
    expect(focus, JSON.stringify(visited)).toMatchObject({ index, clear: true, hit: true });
    await page.keyboard.press("Tab");
  }
  await testInfo.attach("consent-focus-hit-tests", { body: JSON.stringify(visited, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("consent-disclosures.png") });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`W17 consent body and compact target ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await openScenario(page, "pairing-many");
      const picker = page.getByRole("combobox", { name: "Open in Reader" });
      await picker.fill("Coastal");
      await picker.press("ArrowDown");
      await picker.press("Enter");
      const approval = page.getByRole("button", { name: "Open Reader", exact: true });
      await expect(approval).toBeEnabled();
      await expect(approval).toHaveAttribute("aria-describedby", `pairing-target-${pairingId}`);
      const target = page.locator(".approval-target .collection-name");
      expect(await target.evaluate(element => element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth)).toBe(true);
      expect((await approval.boundingBox())!.height).toBeLessThan(70);
      await page.getByText("Allow offline access to additional collections", { exact: true }).click();
      await page.getByText("Details", { exact: true }).click();
      await checkConsentFocus(page, testInfo);
    });

    test(`W17 authorization body focus ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await openScenario(page, "authorization");
      await page.getByRole("combobox", { name: "Choose a collection", exact: true }).fill("Field");
      await page.getByRole("option").first().click();
      await page.getByRole("button", { name: "Review access", exact: true }).click();
      for (const disclosure of await page.locator("details.mdbase-disclosure > summary").all()) await disclosure.click();
      await checkConsentFocus(page, testInfo);
    });

    test(`W17 palette and phone rows ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await openScenario(page, "typical-account");
      if (viewport.width === 390) {
        const hosted = page.locator(".connect-collection-row").filter({ hasText: "Shared research library" });
        await expect(hosted.locator(".connect-status")).toBeHidden();
        expect((await hosted.boundingBox())!.height).toBeLessThan(80);
        await expect(page.locator(".connect-page > header > div > span")).toBeHidden();
      }
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("combobox", { name: "Search collections, apps, computers, sessions and actions" })).toBeFocused();
      await page.keyboard.type("field");
      const mark = page.locator(".mdbase-command-results mark").first();
      await expect(mark).toHaveText(/field/i);
      const colors = await mark.evaluate(element => ({ color: getComputedStyle(element).color, parent: getComputedStyle(element.parentElement!).color, background: getComputedStyle(element).backgroundColor }));
      expect(colors.color).toBe(colors.parent);
      expect(colors.background).not.toBe("rgb(255, 255, 0)");
      expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
      await page.getByRole("dialog", { name: "Commands", exact: true }).screenshot({ path: testInfo.outputPath("palette-matches.png") });
    });
  }
}

test("W17 sharing conflicts give desktop guidance instead of futile retry", async ({ page }) => {
  await openScenario(page, "sync-conflict");
  const error = page.getByRole("alert");
  await expect(error).not.toContainText("replicas");
  await expect(error).toContainText("Resolve the conflicting changes in the desktop app");
  await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(await error.evaluate(element => {
    const separator = document.createElement("span");
    separator.style.color = "var(--line)";
    element.append(separator);
    const neutral = getComputedStyle(separator).color === getComputedStyle(element).borderBottomColor;
    separator.remove();
    return neutral;
  })).toBe(true);
});

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`W24 consent expansion and pending focus ${width} ${colorScheme} ${reducedMotion}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ colorScheme, reducedMotion });
    await openScenario(page, "pairing-many");
    const picker = page.getByRole("combobox", { name: "Open in Reader", exact: true });
    await picker.focus();
    for (let step = 0; step < 45; step++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    // The list scrolls with the page, so it is not a tab stop of its own.
    for (let step = 0; step < 3; step++) await page.keyboard.press("Tab");
    const details = page.locator("details").filter({ has: page.locator("summary", { hasText: "Details" }) });
    await expect(details.locator("summary")).toBeFocused();
    const height = await page.locator(".collection-picker-list").evaluate(element => element.getBoundingClientRect().height);
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await page.waitForTimeout(350);
    expect(await page.locator(".collection-picker-list").evaluate(element => element.getBoundingClientRect().height)).toBe(height);
    const geometry = await details.evaluate(element => {
      const summary = element.querySelector("summary")!;
      const box = summary.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { hit: summary.contains(hit), bottom: element.getBoundingClientRect().bottom, footer: document.querySelector(".approval-footer")!.getBoundingClientRect().top };
    });
    expect(geometry.hit).toBe(true);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.footer);
    await testInfo.attach("expanded-details", { body: await page.screenshot(), contentType: "image/png" });
    await page.goto("/__review/scenario/pairing-many?latency=300");
    await picker.fill("Reading");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const approve = page.getByRole("button", { name: "Open Reader", exact: true });
    let finishApproval!: () => void;
    const approvalResponse = new Promise<void>(resolve => { finishApproval = resolve; });
    await page.route(`**/v1/pairing-requests/${pairingId}/approve`, async route => {
      await approvalResponse;
      await route.continue();
    });
    await approve.focus();
    await expect(approve).toBeFocused();
    await page.keyboard.press("Enter");
    try {
      await expect(page.locator(".approval-actions .is-primary")).toBeDisabled();
      await expect(page.locator(".approval-target")).toBeFocused();
      await expect(page.getByRole("heading", { name: /Reader can now use/ })).toHaveCount(0);
      await testInfo.attach("pending-approval", { body: await page.screenshot(), contentType: "image/png" });
    } finally { finishApproval(); }
    await expect(page.getByRole("heading", { name: /Reader can now use/ })).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
  });
}

test("W24 filter returns to results without typing list shortcuts", async ({ page }) => {
  await openScenario(page, "heavy-account");
  const filter = page.getByRole("searchbox", { name: "Filter collections" });
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await filter.fill("Field");
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(filter).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".connect-collection-link").first()).toBeFocused();
  await page.keyboard.press("j");
  await expect(page.locator(".connect-collection-link").nth(1)).toBeFocused();
  await expect(filter).toHaveValue("");
  for (const key of ["ArrowDown", "Enter"]) {
    await page.keyboard.press("/");
    await filter.fill("Field");
    await page.keyboard.press(key);
    await expect(page.locator(".connect-collection-link").first()).toBeFocused();
    await expect(filter).toHaveValue("Field");
  }
});

test("W24 typed confirms start in the field and keep approval deliberate", async ({ page }) => {
  await openScenario(page, "typical-account");
  const row = page.locator(".connect-collection-row").filter({ has: page.getByRole("link", { name: "Shared research library", exact: true }) });
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox")).toBeFocused();
  await expect(dialog.getByRole("button", { name: "Delete permanently", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await page.getByRole("button", { name: "Delete account…", exact: true }).click();
  await expect(page.getByLabel("Type DELETE to confirm")).toBeFocused();
  await expect(page.getByRole("button", { name: "Delete account permanently", exact: true })).toBeDisabled();
});

test("W24 server errors do not blame the network", async ({ page }) => {
  await openScenario(page, "server-500");
  await expect(page.getByRole("alert")).toContainText("Something went wrong on mdbase. Try again.");
  await expect(page.getByRole("alert")).not.toContainText("Check your connection");
});

test("W24 capped palette keeps its search header and active result visible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScenario(page, "heavy-account");
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Commands", exact: true });
  const input = palette.getByRole("combobox");
  await page.keyboard.press("End");
  const visible = await palette.evaluate(element => {
    const results = element.querySelector(".mdbase-command-results")!;
    const active = element.querySelector('[aria-selected="true"]')!;
    const box = active.getBoundingClientRect();
    const bounds = results.getBoundingClientRect();
    const search = element.querySelector(".mdbase-command-search")!.getBoundingClientRect();
    return { scrollable: results.scrollHeight > results.clientHeight, hit: active.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), top: box.top, bottom: box.bottom, resultsTop: bounds.top, resultsBottom: bounds.bottom, headerBottom: search.bottom };
  });
  await testInfo.attach("palette-scroll", { body: JSON.stringify(visible), contentType: "application/json" });
  expect(visible.scrollable).toBe(true);
  expect(visible.hit).toBe(true);
  expect(visible.top).toBeGreaterThanOrEqual(visible.resultsTop);
  expect(visible.bottom).toBeLessThanOrEqual(visible.resultsBottom);
  expect(visible.headerBottom).toBeLessThanOrEqual(visible.resultsTop);
  await input.fill("Theme");
  await expect.poll(() => palette.locator(".mdbase-command-results").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
});

test.describe("W17 touch hints", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("hides keyboard hints on coarse pointers", async ({ page }) => {
    await openScenario(page, "typical-account");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expect(page.locator(".sidebar-search kbd")).toBeHidden();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".mdbase-command-results kbd").first()).toBeHidden();
  });
});

test("W17 pending approval retains heading focus", async ({ page }) => {
  await openScenario(page, "authorization");
  await page.getByRole("combobox", { name: "Choose a collection", exact: true }).fill("Field");
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: "Review access", exact: true }).click();
  let finishApproval!: () => void;
  const approvalResponse = new Promise<void>(resolve => { finishApproval = resolve; });
  await page.route(`**/v1/authorization-requests/${authorizationId}/approve`, async route => {
    await approvalResponse;
    await route.fulfill({ json: { status: "setting_up" } });
  });
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Collection", exact: true })).toBeFocused();
  await page.route(`**/v1/authorization-requests/${authorizationId}/status`, route => route.fulfill({ json: { status: "setting_up" } }));
  finishApproval();
  await expect(page.getByRole("heading", { name: "Finishing collection setup…", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) test(`W11 list slots and shell ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
    await page.route(url => url.pathname === "/v1/me", async route => {
      const response = await route.fetch();
      const data = await response.json();
      data.connectors[0].compatibility = "upgrade_required";
      data.connectors[0].minimum_connector_version = "0.1.0-beta.155";
      await route.fulfill({ response, json: data });
    });
    await openScenario(page, "typical-account");
    const rows = page.locator(".connect-collections-list .connect-collection-row");
    const geometry = await rows.evaluateAll(elements => elements.map(element => {
      const row = element.getBoundingClientRect();
      const statusElement = element.querySelector<HTMLElement>(".connect-status")!;
      const status = statusElement.getBoundingClientRect();
      const menu = element.querySelector(".connect-collection-menu button")!.getBoundingClientRect();
      return { height: row.height, statusLeft: status.left, statusOverflow: statusElement.scrollWidth - statusElement.clientWidth, menuLeft: menu.left, centre: menu.top + menu.height / 2 - row.top - row.height / 2, menuHeight: menu.height };
    }));
    expect(geometry).toHaveLength(7);
    if (viewport.width === 1440) expect(new Set(geometry.map(row => row.statusLeft)).size).toBe(1);
    expect(new Set(geometry.map(row => row.menuLeft)).size).toBe(1);
    expect(geometry.every(row => row.statusOverflow <= 1)).toBe(true);
    if (viewport.width === 390) {
      expect(geometry.every(row => row.height >= 64)).toBe(true);
      expect(geometry.every(row => Math.abs(row.centre) <= 1 && row.menuHeight >= 44)).toBe(true);
      expect((await rows.first().boundingBox())!.y).toBeLessThan(300);
    }
    const hosted = rows.filter({ hasText: "Shared research library" });
    await expect(hosted.locator(".connect-status")).toHaveText("");
    await expect(hosted.locator(".connect-status svg")).toHaveCount(0);
    await expect(rows.locator(".connect-collection-unavailable")).toHaveCount(0);
    expect(await page.locator(".connect-nav .mdbase-mark").evaluate(mark => mark.getAnimations({ subtree: true }).length)).toBe(0);
    expect(await page.locator(".connect-nav .mdbase-mark rect").evaluateAll(segments => segments.every(segment => getComputedStyle(segment).opacity === "1"))).toBe(true);
    await testInfo.attach("W11-collections", { body: await page.screenshot({ path: testInfo.outputPath("collections.png") }), contentType: "image/png" });
    await rows.filter({ hasText: "Field research" }).getByRole("button", { name: "Actions for Field research" }).click();
    await expect(page.getByRole("menuitem", { name: "Overview", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("g"); await page.keyboard.press("o");
    await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
    const upgraded = page.locator('[data-command="computer:computer-0"]');
    const upgradeStatus = await upgraded.locator(".connect-status").boundingBox();
    const upgradeLink = await upgraded.getByRole("link", { name: "Install version 0.1.0-beta.155 or later" }).boundingBox();
    expect(upgradeLink!.y).toBeGreaterThanOrEqual(upgradeStatus!.y + upgradeStatus!.height);
    expect(await upgraded.locator(".connect-status").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (viewport.width === 390) expect(upgradeLink!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
    const computer = page.getByRole("button", { name: "Actions for Studio MacBook" });
    await computer.click();
    await page.getByRole("menuitem", { name: "Revoke", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Revoke Studio MacBook?" });
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toHaveAttribute("data-open", "false");
    await expect(confirmation).toHaveCount(0);
    await expect(computer).toBeFocused();
    await testInfo.attach("W11-computers", { body: await page.screenshot({ path: testInfo.outputPath("computers.png") }), contentType: "image/png" });
    await page.keyboard.press("g"); await page.keyboard.press("u");
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await page.keyboard.press("g"); await page.keyboard.press("a");
    await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
    await expect(page.locator(".connect-application > summary b")).toHaveCount(0);
    const firstColumns = await page.locator(".connect-application > summary > span").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    expect(new Set(firstColumns).size).toBe(1);
    await testInfo.attach("W11-apps", { body: await page.screenshot({ path: testInfo.outputPath("apps.png") }), contentType: "image/png" });
    await openScenario(page, "heavy-account");
    await page.getByRole("searchbox", { name: "Filter collections" }).fill("zzqq");
    const empty = page.locator(".connect-empty");
    const alignment = await empty.evaluate(element => {
      const title = element.querySelector("strong")!.getBoundingClientRect();
      const icon = element.querySelector("svg")!.getBoundingClientRect();
      const label = document.createRange();
      label.selectNodeContents(element.querySelector("button")!);
      return { titleLeft: title.left, buttonLeft: label.getBoundingClientRect().left, titleTop: title.top, iconTop: icon.top };
    });
    expect(alignment.buttonLeft).toBe(alignment.titleLeft);
    expect(Math.abs(alignment.titleTop - alignment.iconTop)).toBeLessThanOrEqual(2);
    await testInfo.attach("W11-filter", { body: await page.screenshot({ path: testInfo.outputPath("filter.png") }), contentType: "image/png" });
  });
}

test("offline route changes have one inline recovery state", async ({ page }) => {
  const sessions = page.waitForResponse("**/v1/account/sessions");
  await openScenario(page, "typical-account");
  await sessions;
  await page.route("**/v1/**", route => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "Actions for Shared research library" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Rename Shared research library" }).fill("Changed offline");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".connect-load-error")).toBeVisible();
  await page.getByRole("link", { name: "Apps", exact: true }).click();
  await expect(page.locator(".connect-load-error")).toContainText("We couldn't load Apps");
  await expect(page.locator(".connect-notice.error")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`consent picker clears the real footer ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await openScenario(page, "pairing-many");
      const picker = page.getByRole("combobox", { name: "Open in Reader" });
      await expect(page.getByText(/This request link expires .*Access you allow continues until you revoke it/)).toBeVisible();
      for (const selected of [false, true]) {
        if (selected) {
          const longName = "Coastal restoration research archive with a very long selected collection name — field notebooks";
          const option = page.getByRole("option").last();
          const name = await option.getAttribute("aria-label");
          await page.route(`**/v1/pairing-requests/${pairingId}`, async route => {
            const response = await route.fetch();
            const data = await response.json();
            data.pairing.collections.find((collection: { display_name: string }) => collection.display_name === name).display_name = longName;
            await route.fulfill({ response, json: data });
          });
          await page.reload();
          await page.getByRole("option", { name: longName }).click();
          await expect(page.getByRole("button", { name: `Open Reader` })).toBeEnabled();
        }
        await picker.focus();
        for (let index = 0; index < 30; index++) await picker.press("ArrowDown");
        await expect.poll(() => picker.evaluate(input => {
          const option = document.getElementById(input.getAttribute("aria-activedescendant")!)!;
          const bounds = option.getBoundingClientRect();
          const footer = document.querySelector(".approval-footer")!.getBoundingClientRect();
          return bounds.top >= 0 && bounds.bottom <= footer.top
            && option.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
        })).toBe(true);
        expect(await page.getByRole("button", { name: "Cancel", exact: true }).evaluate(button => {
          const text = document.createRange();
          text.selectNodeContents(button);
          return text.getClientRects().length;
        })).toBe(1);
        const path = testInfo.outputPath(selected ? "long-selected-picker.png" : "unselected-picker.png");
        await page.screenshot({ path });
        await testInfo.attach(selected ? "long-selected-picker" : "unselected-picker", { path, contentType: "image/png" });
      }
    });
    test(`signup compact validation paints clearly ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await openScenario(page, "signup");
      const email = page.getByRole("textbox", { name: "Email", exact: true });
      const submit = page.getByRole("button", { name: "Send verification link" });
      const field = (await email.boundingBox())!;
      expect((await submit.boundingBox())!.y - field.y - field.height).toBeLessThan(40);
      await email.fill("notanemail");
      await submit.click();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      const errorId = await email.getAttribute("aria-describedby");
      await expect(page.locator(`[id="${errorId}"]`)).toHaveText("Enter a valid email address.");
      await expect(email).toHaveCSS("outline-width", "2px");
      await expect(page.getByText("Connect apps to your Markdown files, on your computers or hosted by mdbase.")).toBeVisible();
      const pagePath = testInfo.outputPath("signup-invalid.png"), fieldPath = testInfo.outputPath("signup-invalid-field.png");
      await page.screenshot({ path: pagePath });
      await email.screenshot({ path: fieldPath });
      await testInfo.attach("signup-invalid", { path: pagePath, contentType: "image/png" });
      await testInfo.attach("signup-invalid-field", { path: fieldPath, contentType: "image/png" });
    });
  }
}

for (const provider of ["GitHub", "Google"]) test(`OAuth signup with ${provider} requires agreements before getting started`, async ({ page }) => {
  await openScenario(page, "signup");
  await page.getByRole(provider === "GitHub" ? "link" : "button", { name: `Continue with ${provider}` }).click();
  await expect(page).toHaveURL(/\/signup\?external=1/);
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Maya Chen");
  const create = page.getByRole("button", { name: "Create account", exact: true });
  await expect(create).toBeDisabled();
  expect((await page.request.get("/v1/me")).status()).toBe(401);
  await page.getByRole("checkbox", { name: /I agree to the/ }).check();
  await expect(page.getByRole("checkbox", { name: /Send me occasional product updates/ })).not.toBeChecked();
  const gettingStarted = page.waitForURL(/\/getting-started$/, { waitUntil: "commit" });
  await create.click();
  await gettingStarted;
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) test(`Portal keyboard and cached palette ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme });
    const sessions = page.waitForResponse("**/v1/account/sessions");
    await openScenario(page, "heavy-account");
    await sessions;
    const requests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/v1/")) requests.push(request.url()); });
    const search = page.getByRole("button", { name: /^Search/ });
    await search.click();
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    const query = palette.getByRole("combobox");
    for (const [term, label] of [["Coastal restoration", /Coastal restoration/], ["coastal archive storage", /Coastal.*Storage/], ["coastal archive access", /Coastal.*Access/], ["Reader", /^Reader/], ["Travel laptop", /^Travel laptop/], ["Travel Safari", /^Travel Safari/], ["Rename Shared", /^Rename Shared research library/], ["Sign out", /^Sign out/]]) {
      await query.fill(term);
      await expect(palette.getByRole("option", { name: label }).first()).toBeVisible();
    }
    await query.fill("no such collection or command");
    await expect(palette.getByRole("status")).toContainText("Clear the search to browse.");
    expect(requests).toEqual([]);
    await query.fill("Coastal restoration");
    await expect(query).toHaveAttribute("aria-activedescendant", /collection:/);
    await testInfo.attach("cached-palette", { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(search).toBeFocused();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("c");
    await expect(page.getByRole("dialog", { name: "Add collection", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Control+/");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("/");
    const filter = page.getByRole("searchbox", { name: "Filter collections" });
    await expect(filter).toBeFocused();
    await page.keyboard.type("c?g");
    await expect(filter).toHaveValue("c?g");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await filter.fill("");
    await filter.press("Tab");
    await search.focus();
    await page.keyboard.press("j");
    const first = page.locator(".connect-collection-link").first();
    const destination = await first.getAttribute("href");
    await expect(first).toBeFocused();
    await page.keyboard.press("j");
    await expect(page.locator(".connect-collection-link").nth(1)).toBeFocused();
    await page.keyboard.press("k");
    await expect(first).toBeFocused();
    expect(await first.evaluate(element => getComputedStyle(element, "::after").outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new URL(destination!, page.url()).href);
    await page.keyboard.press("g"); await page.keyboard.press("o");
    await expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible();
    await page.keyboard.press("j");
    await expect(page.locator('[data-command="computer:computer-0"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-command="computer:computer-0"]').getByRole("button", { name: "Actions for Studio MacBook", exact: true })).toBeFocused();
    await page.keyboard.press("c");
    await expect(page.getByRole("dialog", { name: "Add collection", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: /^New collection/ })).toBeFocused();
    await page.keyboard.press("Escape");
  });

  for (const colorScheme of ["light", "dark"] as const) test(`Portal finish ${viewport.width} ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme });
    await openScenario(page, "empty-account");
    await expect(page.locator(".connect-page > header").getByRole("button", { name: "Add collection", exact: true })).toHaveCount(0);
    await expect(page.locator(".connect-page > header > div > span")).toHaveCount(0);
    await openScenario(page, "heavy-account");
    const filter = page.getByRole("searchbox", { name: "Filter collections" });
    await filter.fill("coastal archive");
    await expect(page.locator(".connect-collection-row").first()).toContainText("Coastal restoration");
    await filter.fill("No such collection");
    await expect(page.getByRole("button", { name: "Clear filter", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Clear search", exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(filter).toBeFocused();
    if (viewport.width === 390) {
      await expect(page.getByRole("link", { name: /^Open in editor:/ }).filter({ visible: true })).toHaveCount(0);
      const offline = page.locator(".connect-collection-row").filter({ hasText: "Offline" }).first();
      await expect(offline.locator(".connect-collection-name small")).toContainText("Travel laptop");
      const name = await offline.locator(".connect-collection-name small").boundingBox();
      const status = await offline.locator(".connect-status").boundingBox();
      expect(Math.abs(status!.y - name!.y)).toBeLessThanOrEqual(2);
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.locator(".connect-navigation-sheet .product-brand")).toBeVisible();
      await expect(page.locator(".connect-navigation-sheet .mdbase-motion-keys-first")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    await openScenario(page, "authorization");
    const picker = page.getByRole("combobox", { name: "Choose a collection", exact: true });
    await expect(picker).toBeVisible();
    const contrast = await picker.evaluate(element => {
      const canvas = document.createElement("canvas").getContext("2d")!;
      const luminance = (color: string) => {
        canvas.fillStyle = color;
        canvas.fillRect(0, 0, 1, 1);
        const channels = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const foreground = luminance(getComputedStyle(element, "::placeholder").color);
      const background = luminance(getComputedStyle(document.body).backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    const option = page.getByRole("option", { name: "Field research", exact: true });
    await expect(option).toHaveAccessibleDescription(/Studio MacBook/);
    await option.click();
    await page.getByRole("button", { name: "Review access", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow access", exact: true })).toBeVisible();
    if (viewport.width === 390) await expect(page.locator(".request-origin-guidance")).toBeHidden();
    await openScenario(page, "signup");
    const authButtons = page.locator(".auth-providers .mdbase-button, .password-auth-form .mdbase-button");
    await expect(authButtons).toHaveCount(3);
    for (const button of await authButtons.all()) await expect(button).toHaveCSS("font-size", "13px");
  });
}

test.describe("touch commands", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps one visible search entry and hides shortcut hints", async ({ page }) => {
    await openScenario(page, "heavy-account");
    const search = page.getByRole("button", { name: /^Search/ });
    await expect(search).toHaveCount(1);
    await expect(search.locator("kbd")).toBeHidden();
    await expect(page.locator(".connect-list-filter > kbd")).toBeHidden();
    await search.click();
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    await expect(palette.getByRole("combobox")).toBeFocused();
    await expect(palette.locator(".mdbase-command-results kbd").first()).toBeHidden();
    await expect(palette.locator("footer")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(search).toBeFocused();
  });
});

test("palette actions reuse row dialogs, including non-optimistic revoke and session confirms", async ({ page }) => {
  await openScenario(page, "typical-account");
  const run = async (term: string, name: string | RegExp) => {
    await page.getByRole("button", { name: /^Search/ }).click();
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    await palette.getByRole("combobox").fill(term);
    await palette.getByRole("option", { name, exact: true }).click();
  };
  await run("rename shared", "Rename Shared research library Cloud copy");
  await expect(page.getByRole("dialog", { name: "Rename Shared research library", exact: true })).toBeVisible();
  const rename = page.getByRole("dialog").getByRole("textbox");
  await expect(rename).toBeFocused();
  expect(await rename.evaluate(element => (element as HTMLInputElement).selectionEnd! - (element as HTMLInputElement).selectionStart!)).toBe("Shared research library".length);
  await page.keyboard.press("Escape");
  await run("delete shared", "Delete Shared research library Cloud copy");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Delete permanently" })).toBeDisabled();
  await page.keyboard.press("Escape");
  let acknowledge!: () => void;
  const held = new Promise<void>(resolve => { acknowledge = resolve; });
  await page.route("**/v1/grants/revoke-batch", async route => { await held; await route.continue(); });
  await run("Revoke Reader", "Revoke Reader");
  const confirm = page.getByRole("dialog", { name: "Revoke Reader?", exact: true });
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirm.getByRole("button", { name: "Revoke app", exact: true }).click();
  await expect(confirm.getByRole("button", { name: "Revoking access…", exact: true })).toBeDisabled();
  await expect(page.locator('[data-command="app:app-1"]')).toBeVisible();
  acknowledge();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator(".connect-main :focus")).toBeVisible();
  await expect(page.locator('[data-command="app:app-1"]')).toHaveCount(0);
  await run("Revoke Home workstation", "Revoke Home workstation");
  const computer = page.getByRole("dialog", { name: "Revoke Home workstation?", exact: true });
  await expect(computer.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(page.locator('[data-command="computer:computer-1"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(computer).toHaveCount(0);
  await run("dark theme", "Dark Theme");
  await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await run("Language", "Language");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await run("Travel Safari", /^Travel Safari Last used /);
  await expect(page.locator('[data-command="session:session-2"]')).toBeFocused();
  await run("Sign out Travel Safari", "Sign out Travel Safari");
  const session = page.getByRole("dialog", { name: "Sign out Travel Safari?" });
  await expect(session.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await run("Sign out", "Sign out");
  await expect(page.getByRole("dialog", { name: "Sign out of this browser?" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await (await page.request.get("/v1/account/sessions")).json()).sessions).toHaveLength(3);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
for (const colorScheme of ["light", "dark"] as const) test(`signup blur validation preserves the first consent pointer click ${viewport.width} ${colorScheme}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme });
  await openScenario(page, "signup-agreements");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Maya Chen");
  await page.getByLabel("Password", { exact: true }).fill("a-long-local-review-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("a-different-local-review-password");
  const agreement = page.getByRole("checkbox", { name: /I agree to the/ });
  await agreement.scrollIntoViewIfNeeded();
  const before = await agreement.boundingBox();
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await expect(page.getByText("Passwords do not match.", { exact: true })).toBeVisible();
  await page.mouse.up();
  await expect(agreement).toBeChecked();
  expect((await agreement.boundingBox())!.y).toBe(before!.y);
  await expect(page.getByLabel("Confirm password", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("checkbox", { name: /Send me occasional product updates/ })).not.toBeChecked();
});
}

test("grant waits for acknowledged status and settles the confirmed row", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let approved = false;
  await page.route(`**/v1/authorization-requests/${authorizationId}/status`, route => route.fulfill({ json: { status: approved ? "approved" : "pending" } }));
  await openScenario(page, "authorization");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Choose a collection", exact: true })).toBeFocused();
  await expect(page.getByText(/All permissions listed below are required/)).toHaveCount(0);
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow access", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get("/v1/me")).json()).pending_authorizations.length).toBe(1);
  await page.getByRole("button", { name: "Review access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Collection", exact: true })).toBeFocused();
  const reviewHeader = await page.locator(".request-identity").elementHandle();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByText("The app does not have access yet.", { exact: false })).toBeVisible();
  await expect(page.locator(".grant-moment")).toHaveCount(0);
  expect(await reviewHeader!.evaluate(element => element.isConnected && getComputedStyle(element).position === "sticky")).toBe(true);
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const row = document.querySelector(".grant-moment");
      if (!row) return;
      observer.disconnect();
      requestAnimationFrame(() => row.getAnimations().forEach(animation => animation.pause()));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  approved = true;
  await expect(page.getByRole("heading", { name: "TaskNotes can now use Field research", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "TaskNotes can now use Field research", exact: true })).toBeFocused();
  await page.evaluate(() => document.getAnimations().forEach(animation => animation.pause()));
  expect(await page.locator(".grant-moment").evaluate(element => element.getAnimations().map(animation => animation.effect!.getTiming().duration))).toEqual([180, 180]);
  for (const time of [0, 60, 120, 180, 240, 300]) {
    await page.evaluate(time => document.getAnimations().forEach(animation => { animation.currentTime = time; }), time);
    const path = testInfo.outputPath(`grant-${time}ms.png`);
    await page.locator(".grant-moment").screenshot({ path, animations: "allow" });
    await testInfo.attach(`grant-${time}ms`, { path, contentType: "image/png" });
    if (time === 180) await expect(page.locator(".grant-moment")).toHaveCSS("opacity", "1");
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openScenario(page, "authorization-approved");
  await expect(page.locator(".grant-moment")).toHaveCSS("opacity", "1");
  expect(await page.locator(".grant-moment").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
});

test("a first visit asks for sign-in without claiming the session expired", async ({ page }) => {
  await openScenario(page, "session-expired");
  await expect(page.getByText("Your session expired.", { exact: false })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("reason")).toBe(false);
  expect(new URL(new URL(page.url()).searchParams.get("return_to")!).pathname).toBe("/account");
});

test("an expired session says so and keeps the destination", async ({ page }) => {
  await openScenario(page, "account-sessions");
  await page.route(url => url.pathname === "/v1/me", route => route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Sign in" } } }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status").filter({ hasText: "Your session expired." })).toBeVisible();
  expect(new URL(new URL(page.url()).searchParams.get("return_to")!).pathname).toBe("/account");
});

test("committing a collection announces the entire selected name", async ({ page }) => {
  await openScenario(page, "authorization");
  const receipt = page.locator('[aria-live="polite"][aria-atomic="true"]').filter({ hasText: "Selected:" });
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await expect(receipt).toHaveText("Selected: Field research");
  const picker = page.getByRole("combobox", { name: "Choose a collection", exact: true });
  await picker.fill("Garden");
  await picker.press("ArrowDown");
  await expect(receipt).toHaveText("Selected: Field research");
  await picker.press("Enter");
  await expect(receipt).toHaveText("Selected: Garden journal");
});

test("required-only permission copy matches the declared request", async ({ page }) => {
  await openScenario(page, "authorization-required");
  await expect(page.getByText("All permissions listed below are required by TaskNotes. You can allow them together or deny this request.", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const colorScheme of ["light", "dark"] as const) test(`foundation dialogs ${viewport.width} ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await openScenario(page, "collection-storage");
    const trigger = page.getByRole("button", { name: "Actions for Shared research library" });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toHaveCount(1);
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Delete permanently", exact: true })).toBeDisabled();
    for (let step = 0; step < 8; step++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
    }
    await dialog.getByRole("textbox").fill("Shared research library");
    await expect(dialog.getByRole("button", { name: "Delete permanently", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("confirm.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(dialog).toHaveAccessibleName("Commands");
    await expect(dialog.getByRole("combobox")).toBeFocused();
    expect(await dialog.evaluate(element => element.getAnimations().length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("palette.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`phone navigation is a dismissible sheet in ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme });
    await openScenario(page, "typical-account");
    const trigger = page.getByRole("button", { name: "Open menu" });
    await trigger.click();
    const sheet = page.getByRole("dialog", { name: "Navigation" });
    await expect(sheet.getByRole("link", { name: "Collections", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("navigation.png") });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await sheet.getByRole("link", { name: "Computers", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Computers", level: 1 })).toBeVisible();
  });
}

test("collection filters appear at ten rows and explain no matches", async ({ page }) => {
  await openScenario(page, "typical-account");
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await openScenario(page, "heavy-account");
  await page.getByRole("searchbox", { name: "Filter collections" }).fill("No such collection");
  await expect(page.getByText("No collections match", { exact: true })).toBeVisible();
  await expect(page.locator(".connect-collection-row")).toHaveCount(0);
});

test("hosted creation validates on blur without moving its action", async ({ page }, testInfo) => {
  await openScenario(page, "empty-account");
  await page.getByRole("button", { name: /^New collection/ }).click();
  const dialog = page.getByRole("dialog", { name: "Add collection" });
  const name = dialog.getByRole("textbox");
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  const before = await create.evaluate(element => (element as HTMLElement).offsetTop);
  await name.focus();
  await page.keyboard.press("Tab");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("alert")).toHaveText("Enter a collection name.");
  expect(await create.evaluate(element => (element as HTMLElement).offsetTop)).toBe(before);
  await page.screenshot({ path: testInfo.outputPath("creation-validation.png") });
});

test("failed revocation stays visible and never removes a grant optimistically", async ({ page }, testInfo) => {
  await openScenario(page, "applications");
  await page.locator(".connect-application > summary").first().click();
  await page.getByRole("button", { name: "Revoke app", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await page.route("**/v1/grants/revoke-batch", async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ status: 503, json: { error: { message: "Reader access could not be revoked. Try again." } } });
  });
  const grants = page.locator(".connect-grant");
  const count = await grants.count();
  await dialog.getByRole("button", { name: "Revoke app", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Revoking access…" })).toHaveAttribute("aria-busy", "true");
  await expect(grants).toHaveCount(count);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revoke app", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("revocation-error.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("closing the palette during entry reverses from the current opacity", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openScenario(page, "typical-account");
  const sample = await page.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await nextFrame();
    await nextFrame();
    const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
    let entering = Number(getComputedStyle(dialog).opacity);
    for (let frame = 0; entering === 0 && frame < 10; frame++) {
      await nextFrame();
      entering = Number(getComputedStyle(dialog).opacity);
    }
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Promise.resolve();
    const start = Number(getComputedStyle(dialog).opacity);
    const mounted = dialog.isConnected;
    await nextFrame();
    return { entering, start, leaving: Number(getComputedStyle(dialog).opacity), mounted };
  });
  expect(sample.entering).toBeGreaterThan(0);
  expect(sample.entering).toBeLessThan(1);
  expect(sample.start).toBeLessThan(1);
  expect(Math.abs(sample.start - sample.entering)).toBeLessThan(.15);
  expect(sample.leaving).toBeLessThanOrEqual(sample.start);
  expect(sample.mounted).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("rename survives navigation and reload", async ({ page }, testInfo) => {
  await openScenario(page, "collection-storage");
  await page.getByRole("button", { name: "Actions for Shared research library" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Rename Shared research library" }).fill("Coastal research library");
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/v1/hosted/collections/hosted-0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
  const receipt = page.locator(".mdbase-toast");
  await expect(receipt).toBeVisible();
  await receipt.hover();
  await expect(receipt).toHaveCSS("font-size", "13px");
  await expect(receipt.getByRole("button", { name: "Undo", exact: true })).toHaveClass(/mdbase-button is-secondary/);
  await expect(receipt.getByRole("button", { name: "Dismiss", exact: true })).toHaveClass(/mdbase-button is-tertiary/);
  await page.screenshot({ path: testInfo.outputPath("rename-receipt.png") });
  await page.reload();
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
  if (await page.getByRole("button", { name: "Open menu" }).isVisible()) await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coastal research library", exact: true })).toBeVisible();
});

test("successful collection deletion focuses the next surviving row", async ({ page }) => {
  await openScenario(page, "typical-account");
  await page.getByRole("button", { name: "Actions for Coastal survey team", exact: true }).click();
  const remove = page.getByRole("menuitem", { name: "Delete", exact: true });
  await expect(remove).toHaveClass(/mdbase-menu-item is-danger/);
  await remove.click();
  const dialog = page.getByRole("dialog", { name: "Delete Coastal survey team?", exact: true });
  await expect(dialog).toHaveAccessibleDescription("All hosted data in Coastal survey team will be permanently deleted. This cannot be undone.");
  await dialog.getByRole("textbox").fill("Coastal survey team");
  await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.locator('[data-command="collection:hosted-1"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Field research", exact: true })).toBeFocused();
});

test("signed-out pairing signs in locally and remembers approval", async ({ page }) => {
  await openScenario(page, "pairing-signed-out");
  await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("maya@chen.example");
  await page.getByLabel("Password", { exact: true }).fill("review-only-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await page.getByRole("button", { name: "Open Reader", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/v1/pairing-requests/${pairingId}`)).json()).pairing.approved_at).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reader can now use Field research", exact: true })).toBeVisible();
});

test("create-new pairing creates a collection and persists it", async ({ page }) => {
  await openScenario(page, "pairing-create-new");
  await page.getByRole("button", { name: "Open Reader", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/v1/pairing-requests/${pairingId}`)).json()).pairing.creation.completed).toBe(true);
  await page.goto("/collections");
  await expect(page.getByText("Reader highlights", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Reader highlights", { exact: true }).first()).toBeVisible();
});

test("consent adds a real grant and removes the pending request", async ({ page }) => {
  await openScenario(page, "authorization");
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await page.getByRole("button", { name: /Review access/ }).click();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByText("Access approved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Access approved", { exact: true })).toBeVisible();
  const data = await (await page.request.get("/v1/me")).json();
  expect(data.pending_authorizations).toEqual([]);
  expect(data.grants.filter(grant => grant.collection_id === "collection-0" && grant.application_id === "app-0")).toHaveLength(2);
  expect(await (await page.request.get(`/v1/authorization-requests/${authorizationId}/status`)).json()).toEqual({ status: "approved" });
});

for (const reducedMotion of ["reduce", "no-preference"] as const) test(`setup progress stays non-optimistic with ${reducedMotion} motion`, async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion });
  await openScenario(page, "authorization-setting-up");
  await expect(page.getByText("The app does not have access yet.", { exact: false })).toBeVisible();
  await expect(page.getByText("Access approved", { exact: true })).toHaveCount(0);
  const line = page.locator(".collection-setup-progress");
  await expect(line).toHaveCSS("animation-delay", "0.4s");
  expect(await line.evaluate(element => getComputedStyle(element, "::after").animationName)).toBe(reducedMotion === "reduce" ? "none" : "setup-progress");
  await expect(line).toHaveCSS("opacity", "1");
  await testInfo.attach(`setup-${reducedMotion}`, { body: await page.screenshot(), contentType: "image/png" });
});

test("account session revocation sticks after reload", async ({ page }) => {
  await openScenario(page, "account-sessions");
  await page.getByRole("button", { name: "Sign out other sessions", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get("/v1/account/sessions")).json()).sessions.length).toBe(1);
  await page.reload();
  await expect(page.getByText("Studio Chrome", { exact: true })).toBeVisible();
  await expect(page.getByText("Travel Safari", { exact: true })).toHaveCount(0);
});

test("signup creates the starter collection and hands off to the configured Editor", async ({ page, baseURL }) => {
  await page.route("http://127.0.0.1:4802/?demo=300", route => route.fulfill({ contentType: "text/html", body: "<h1>Editor handoff</h1>" }));
  await openScenario(page, "signup-agreements");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Maya Chen");
  await page.getByLabel("Password", { exact: true }).fill("a-long-local-review-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("a-long-local-review-password");
  await page.getByRole("checkbox", { name: /I agree to the/ }).check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4802/?demo=300");
  await expect(page.getByRole("heading", { name: "Editor handoff" })).toBeVisible();
  await page.goto(`${baseURL}/collections`);
  await expect(page.getByText("My first collection", { exact: true }).first()).toBeVisible();
});

test("feedback sends to the local inbox without credentials", async ({ page }) => {
  await openScenario(page, "feedback");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").first().fill("The collection picker makes our coastal survey work easier to find.");
  const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/v1/feedback");
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  expect((await sent).status()).toBe(201);
  await expect(dialog.getByText("Sent privately to the mdbase team.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to your work", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

for (const provider of ["Google", "GitHub"]) test(`${provider} sign-in never leaves the fake server`, async ({ page, baseURL }) => {
  const external: string[] = [];
  page.on("request", request => { if (new URL(request.url()).origin !== baseURL) external.push(request.url()); });
  await openScenario(page, "anonymous");
  await page.getByRole(provider === "Google" ? "button" : "link", { name: `Continue with ${provider}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Collections", exact: true })).toBeVisible();
  expect(external).toEqual([]);
});

test("Control+K opens the palette from a field and closes it again", async ({ page }) => {
  await openScenario(page, "heavy-account");
  await page.getByRole("searchbox").first().focus();
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Commands", exact: true });
  await expect(palette.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(palette).toHaveCount(0);
});

test("overlays stay mounted through their exit in the built bundle", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openScenario(page, "typical-account");
  await page.getByRole("button", { name: /^Search/ }).click();
  await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
  const exit = await page.evaluate(() => new Promise<number>(resolve => {
    const palette = document.querySelector("dialog")!;
    const start = performance.now();
    new MutationObserver((_, observer) => {
      if (palette.isConnected) return;
      observer.disconnect();
      resolve(performance.now() - start);
    }).observe(document.body, { childList: true, subtree: true });
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }));
  expect(exit).toBeGreaterThanOrEqual(100);
  expect(exit).toBeLessThan(300);
});
