import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./review/fixture";
import { authentication, authorizationId, clock, pairingId } from "./review/scenarios.mjs";
import { openSharedStyleFixture } from "../../../packages/app-ui/test/browser-styles";

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) test.describe(`round 9 auth ${width} ${colorScheme}`, () => {
  test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme });
  test("email confirmation keeps the brand anchored and supports correcting the address", async ({ page }) => {
    await page.route("**/v1/auth/password/signup/request", route => route.fulfill({ json: {} }));
    await openScenario(page, "signup");
    const brand = page.locator(".minimal-auth-page > :first-child");
    const before = await brand.boundingBox();
    await page.getByLabel("Email", { exact: true }).fill("typo@example.test");
    await page.getByRole("button", { name: "Send verification link", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeFocused();
    await expect(page.getByText("typo@example.test", { exact: true })).toBeVisible();
    const after = await brand.boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    const footerSizes = await page.locator(".minimal-auth-footer").evaluate(footer => ({
      text: getComputedStyle(footer).fontSize,
      controls: [...footer.querySelectorAll(".mdbase-select")].map(control => getComputedStyle(control).fontSize)
    }));
    expect(footerSizes.controls.length).toBeGreaterThan(0);
    expect(footerSizes.controls.every(size => size === footerSizes.text)).toBe(true);
    await page.getByRole("button", { name: "Use a different email", exact: true }).click();
    await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("typo@example.test");
  });
  for (const scenario of ["onboarding-pending", "onboarding-failed", "pairing-fresh", "pairing-create-new"]) test(`heading receives focus on ${scenario}`, async ({ page }) => {
    await openScenario(page, scenario);
    await expect(page.locator("h1").first()).toBeFocused();
  });
});

async function fillOnly(element: Locator, ring = false) {
  const appearance = await element.evaluate(element => {
    const style = getComputedStyle(element);
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
    const background = luminance(style.backgroundColor);
    let surface = element.parentElement!;
    while (getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)" && surface.parentElement) surface = surface.parentElement;
    const surrounding = luminance(getComputedStyle(surface).backgroundColor);
    const contrast = (foreground: string) => {
      const text = luminance(foreground);
      return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    };
    const ringColor = style.boxShadow.match(/^(?:inset )?(oklch\([^)]*\)|color\([^)]*\)|rgb\([^)]*\))/)?.[1];
    const ringLuminance = ringColor ? luminance(ringColor) : background;
    return { border: style.borderLeftWidth, shadow: style.boxShadow, before: getComputedStyle(element, "::before").content,
      ringContrast: Math.min((Math.max(ringLuminance, surrounding) + .05) / (Math.min(ringLuminance, surrounding) + .05), (Math.max(ringLuminance, background) + .05) / (Math.min(ringLuminance, background) + .05)),
      background: style.backgroundColor, fillContrast: (Math.max(background, surrounding) + .05) / (Math.min(background, surrounding) + .05),
      contrast: Math.min(contrast(style.color), ...[...element.querySelectorAll("strong, small, kbd, .mdbase-command-icon, .cm-completionLabel, .cm-completionDetail, .cm-completionMatchedText, .cm-completionIcon, .cm-diagnosticSource")].map(child => contrast(getComputedStyle(child).color))) };
  });
  expect(appearance.border).toBe("0px");
  if (ring) expect(appearance.shadow).toMatch(/inset/);
  else expect(appearance.shadow).toBe("none");
  expect(appearance.before).toBe("none");
  expect(appearance.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(appearance.contrast).toBeGreaterThanOrEqual(4.5);
  return appearance;
}

async function keyTo(page: Page, target: Locator, key: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await target.evaluate(element => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  await expect(target).toBeFocused();
}

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`W34 ${width} ${colorScheme}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme });

    test("shared notices and diagnostics use tints with real keyboard input", async ({ page }, testInfo) => {
      await page.clock.install({ time: new Date(clock) });
      await openSharedStyleFixture(page);
      const fills: string[] = [];
      for (const tone of ["warning", "error", "info"]) {
        await page.keyboard.press("Tab");
        const action = page.getByRole("button", { name: `Review ${tone}`, exact: true });
        await expect(action).toBeFocused();
        await expect(action).toHaveCSS("outline-style", "solid");
        const notice = page.locator(`.mdbase-collections-notice[data-tone="${tone}"]`);
        await expect(notice).toHaveCSS("border-left-width", "1px");
        await expect(notice).toHaveCSS("border-right-width", "1px");
        await expect(notice).toHaveCSS("box-shadow", "none");
        fills.push(await notice.evaluate(element => getComputedStyle(element).backgroundColor));
      }
      expect(new Set(fills).size).toBe(3);
      await page.keyboard.press("Tab");
      const tab = page.getByRole("button", { name: "Selected navigation", exact: true });
      await expect(tab).toBeFocused();
      await fillOnly(tab);
      expect(await tab.evaluate(element => getComputedStyle(element, "::after").content)).toBe("none");
      await page.keyboard.press("Tab");
      const input = page.getByRole("textbox", { name: "Diagnostic input" });
      await expect(input).toBeFocused();
      for (const severity of ["error", "warning", "info", "hint"]) {
        await page.keyboard.press("Control+a");
        await page.keyboard.type(severity);
        await page.keyboard.press("Control+Shift+m");
        const diagnostic = page.locator(`.cm-diagnostic-${severity}`);
        await expect(diagnostic).toBeVisible();
        await expect(diagnostic).toHaveCSS("border-left-width", "0px");
        const appearance = await fillOnly(diagnostic);
        expect(appearance.fillContrast).toBeGreaterThanOrEqual(2.9);
        await expect(diagnostic.locator(".cm-diagnosticSource")).toHaveCSS("opacity", "1");
        await testInfo.attach(`lint-${severity}-contrast`, { body: JSON.stringify(appearance), contentType: "application/json" });
        await page.keyboard.press("Escape");
        await expect(input).toBeFocused();
        await page.locator(`.cm-lintRange-${severity}`).hover();
        const hint = page.locator(`.cm-tooltip-lint .cm-diagnostic-${severity}`);
        await expect(hint).toBeVisible();
        await expect(hint).toHaveCSS("border-left-width", "0px");
        await expect(hint).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await page.screenshot({ path: testInfo.outputPath(`shared-${severity}-tints.png`) });
        await page.mouse.move(0, 0);
      }
    });

    test("completion current rows keep supporting text readable", async ({ page }, testInfo) => {
      await page.clock.install({ time: new Date(clock) });
      await openSharedStyleFixture(page);
      const input = page.getByRole("textbox", { name: "Completion input" });
      await input.click();
      await page.keyboard.press("Control+Space");
      const current = page.locator('.cm-tooltip-autocomplete li[aria-selected="true"]');
      await expect(current).toContainText("alpha");
      const first = await fillOnly(current);
      await page.clock.runFor(80);
      await page.keyboard.press("ArrowDown");
      await expect(current).toContainText("beta");
      const second = await fillOnly(current);
      expect(first.fillContrast).toBeGreaterThanOrEqual(2.9);
      expect(second.fillContrast).toBeGreaterThanOrEqual(2.9);
      await testInfo.attach("completion-contrast", { body: JSON.stringify({ first, second }), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("completion-current.png") });
      await page.keyboard.press("Enter");
      await expect(input).toHaveText("beta");
    });

    test("palette pointer movement and arrow keys share exactly one active row", async ({ page }, testInfo) => {
      await openScenario(page, "typical-account");
      await page.getByRole("link", { name: "Coastal survey team", exact: true }).click();
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Commands", exact: true });
      const results = palette.locator(".mdbase-command-results");
      const input = palette.getByRole("combobox");
      const storage = results.getByRole("option", { name: /^Go to Storage/ });
      const access = results.getByRole("option", { name: /^Go to Access/ });
      await page.keyboard.type("go to");
      await access.hover();
      await expect(access).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowUp");
      await expect(storage).toHaveAttribute("aria-selected", "true");
      expect(await access.evaluate(element => element.matches(":hover"))).toBe(true);
      await expect(access).toHaveAttribute("aria-selected", "false");
      await expect(access).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(results.locator('[aria-selected="true"]')).toHaveCount(1);
      await expect(input).toHaveAttribute("aria-activedescendant", await storage.getAttribute("id") as string);
      const appearance = await fillOnly(storage, true);
      expect(appearance.fillContrast).toBeLessThan(2);
      expect(appearance.ringContrast).toBeGreaterThanOrEqual(3);
      const ring = await storage.evaluate(element => {
        const style = getComputedStyle(element);
        return { shadow: style.boxShadow, opacity: style.opacity };
      });
      expect(ring.shadow).toMatch(/0px 0px 0px 1px inset|inset 0px 0px 0px 1px/);
      expect(ring.opacity).toBe("1");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/storage\?collection=/);
      await page.keyboard.press("Control+k");
      await page.mouse.move(0, 0);
      await access.hover();
      await expect(access).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowUp");
      await expect(storage).toHaveAttribute("aria-selected", "true");
      const beforeScroll = await results.evaluate(element => element.scrollTop);
      expect(beforeScroll).toBeGreaterThan(0);
      await page.mouse.wheel(0, -80);
      await expect.poll(() => results.evaluate(element => element.scrollTop)).toBeLessThan(beforeScroll);
      await expect(storage).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowDown");
      await expect(access).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowUp");
      await expect(storage).toHaveAttribute("aria-selected", "true");
      const box = await access.boundingBox();
      await page.mouse.move(box!.x + box!.width / 2 + 2, box!.y + box!.height / 2);
      await expect(access).toHaveAttribute("aria-selected", "true");
      await expect(storage).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(results.locator('[aria-selected="true"]')).toHaveCount(1);
      await testInfo.attach("palette-current-contrast", { body: JSON.stringify(appearance), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("palette-current.png") });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/access\?collection=/);
    });

    test("selection uses contrast-checked fills without edge stripes", async ({ page }, testInfo) => {
      await openScenario(page, "typical-account");
      const navigation = page.locator(':is(.connect-nav, .connect-navigation-sheet) a[aria-current="page"]').filter({ visible: true });
      if (width === 390) await page.getByRole("button", { name: "Open menu" }).click();
      await keyTo(page, navigation, "Tab");
      const navStyle = await fillOnly(navigation);
      await expect(navigation).toHaveCSS("outline-style", "solid");
      if (width === 390) await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Commands", exact: true });
      await page.keyboard.press("ArrowDown");
      const paletteStyle = await fillOnly(palette.getByRole("option", { selected: true }), true);
      await page.keyboard.press("Escape");
      await openScenario(page, "anonymous");
      const theme = page.getByRole("combobox", { name: "Color theme", exact: true });
      await keyTo(page, theme, "Tab");
      await page.keyboard.press("Space");
      const list = page.locator(".mdbase-select-list");
      await expect(list).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expect(list.locator(".is-active")).toHaveCSS("outline-style", "solid");
      const selectStyle = await fillOnly(list.getByRole("option", { selected: true }));
      await testInfo.attach("selected-fill-contrast", { body: JSON.stringify({ navStyle, paletteStyle, selectStyle }), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("fill-only-selection.png") });
    });

    test("file access reason uses a plain fill and keyboard actions remain reachable", async ({ page }, testInfo) => {
      await openScenario(page, "pairing-fresh");
      await page.route("**/v1/pairing-requests/**", route => route.fulfill({ json: { pairing: {
        connector_name: "Reader", installation_device: true, account_selection_confirmed: true,
        attested: true, fingerprint: "fixture", approved_at: null,
        file_access: { collection_id: "notes", collection_name: "Notes", actions: ["read"], reason: "Open an attachment", approved_actions: null }
      } } }));
      await page.goto(`/pair/${pairingId}`);
      const reason = page.locator(".installation-file-access-reason");
      await expect(reason).toContainText("Reader says: Open an attachment");
      const appearance = await fillOnly(reason);
      const allow = page.getByRole("button", { name: "Allow", exact: true });
      await keyTo(page, allow, "Tab");
      await expect(allow).toHaveCSS("outline-style", "solid");
      await testInfo.attach("reason-fill", { body: JSON.stringify(appearance), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath("file-access-fill.png"), fullPage: true });
    });

    test("cloud-copy custody is factual across Collections, Overview, Storage and consent", async ({ page }, testInfo) => {
      await openScenario(page, "new-cloud-copy");
      const collection = page.getByRole("link", { name: "New cloud notes", exact: true });
      await keyTo(page, collection, "j");
      const bodies: string[] = [await page.locator(".connect-main").innerText()];
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "New cloud notes", exact: true })).toBeVisible();
      bodies.push(await page.locator(".connect-main").innerText());
      await page.keyboard.press("g"); await page.keyboard.press("t");
      await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
      await expect(page.getByText("Cloud copy configured", { exact: true })).toBeVisible();
      bodies.push(await page.locator(".connect-main").innerText());
      await page.goto(`/authorize/${authorizationId}`);
      await expect(page.getByRole("button", { name: "Allow access", exact: true })).toBeVisible();
      await page.keyboard.press("Tab");
      bodies.push(await page.locator(".authorization-panel").innerText());
      for (const body of bodies) {
        expect(body).toContain("New cloud notes");
        expect(body).toContain("Cloud copy configured");
        expect(body).not.toMatch(/Hosted|stored on your computers/);
      }
      await testInfo.attach("custody-routes", { body: JSON.stringify({ unsupportedAssertions: 0, routes: bodies }), contentType: "application/json" });
    });

    test("focused-row palette context and R cancel restore the same collection row", async ({ page }, testInfo) => {
      await openScenario(page, "typical-account");
      const row = page.getByRole("link", { name: "Coastal survey team", exact: true });
      await keyTo(page, row, "j");
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Commands", exact: true });
      await expect(palette.locator(".mdbase-command-group").first()).toHaveText("Coastal survey team");
      const rename = palette.getByRole("option").filter({ hasText: "Rename Coastal survey team" });
      await expect(rename.locator("kbd")).toHaveText("R");
      await page.keyboard.type("rename coastal");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("textbox", { name: "Rename Coastal survey team", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(row).toBeFocused();
      await page.keyboard.press("r");
      await expect(page.getByRole("textbox", { name: "Rename Coastal survey team", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(row).toBeFocused();
      await page.keyboard.press("?");
      const help = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
      await expect(help.getByText("Rename a hosted collection or computer", { exact: true })).toBeVisible();
      const geometry = await help.locator(".connect-shortcuts").evaluate(element => ({
        columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        fontSize: getComputedStyle(element).fontSize,
        starts: [...element.children].map(child => child.getBoundingClientRect().x)
      }));
      expect(geometry.columns).toBe(1);
      expect(new Set(geometry.starts).size).toBe(1);
      expect(geometry.fontSize).toBe("13px");
      await testInfo.attach("help-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    });

    test("confirmed revocation settles before a single surviving-row focus move", async ({ page }, testInfo) => {
      await openScenario(page, "applications");
      const reader = page.locator('[data-command="app:app-1"]');
      await keyTo(page, reader.locator(":scope > summary"), "j");
      await page.keyboard.press("Enter");
      await keyTo(page, reader.getByRole("button", { name: "Revoke app", exact: true }), "Tab");
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Revoke Reader?", exact: true });
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      let confirm!: () => void;
      const held = new Promise<void>(resolve => { confirm = resolve; });
      await page.route("**/v1/grants/revoke-batch", async route => { await held; await route.continue(); });
      let readback!: () => void;
      const refreshed = new Promise<void>(resolve => { readback = resolve; });
      await page.route("**/v1/me", async route => { await refreshed; await route.continue(); });
      let metadata!: () => void;
      const configuration = new Promise<void>(resolve => { metadata = resolve; });
      await page.route("**/v1/ui-configuration", async route => { await configuration; await route.continue(); });
      await page.evaluate(() => {
        Object.assign(window, { rowFocus: [] });
        document.addEventListener("focusin", event => {
          const target = event.target as HTMLElement;
          const row = target.closest("[data-list-item]");
          if (row && !target.closest("dialog")) (window as unknown as { rowFocus: string[] }).rowFocus.push(row.getAttribute("data-command")!);
        });
      });
      await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
      await expect(dialog.getByRole("button", { name: "Revoking access…", exact: true })).toBeDisabled();
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.keyboard.press("Tab");
        await expect(dialog).toBeFocused();
      }
      await expect(reader).toHaveCount(1);
      confirm();
      await expect(dialog).toBeFocused();
      await expect(reader).toHaveCount(1);
      readback();
      await expect(reader).toHaveCount(0);
      await expect(page.locator(".connect-main :focus")).toBeVisible();
      const focus = await page.evaluate(() => (window as unknown as { rowFocus: string[] }).rowFocus);
      expect(focus).toHaveLength(1);
      expect(focus[0]).not.toBe("app:app-1");
      await testInfo.attach("confirmed-revoke-focus", { body: JSON.stringify(focus), contentType: "application/json" });
      metadata();
    });

    test("failed revocation releases the dialog while overview readback is held", async ({ page }) => {
      await openScenario(page, "applications");
      const reader = page.locator('[data-command="app:app-1"]');
      await keyTo(page, reader.locator(":scope > summary"), "j");
      await page.keyboard.press("Enter");
      await keyTo(page, reader.getByRole("button", { name: "Revoke app", exact: true }), "Tab");
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Revoke Reader?", exact: true });
      let release!: () => void;
      let requested = false;
      const readback = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/v1/me", async route => { requested = true; await readback; await route.continue(); });
      await page.route("**/v1/grants/revoke-batch", route => route.fulfill({ status: 500, json: { error: { message: "Revocation failed" } } }));
      try {
        await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
        await expect.poll(() => requested).toBe(true);
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
        await expect(dialog.getByRole("button", { name: "Revoke app", exact: true })).toBeEnabled();
        await expect(reader).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(reader).toBeVisible();
      } finally { release(); }
    });

    test("rejected password sign-in focuses the first invalid field with its error", async ({ page }) => {
      await openScenario(page, "anonymous");
      await page.route("**/v1/auth/password/login", route => route.fulfill({ status: 401, json: { error: { message: "Email or password is incorrect." } } }));
      const email = page.getByLabel("Email", { exact: true });
      const password = page.getByLabel("Password", { exact: true });
      await page.keyboard.type("wrong@example.test");
      await page.keyboard.press("Tab");
      await expect(password).toBeFocused();
      await page.keyboard.type("incorrect-password");
      await page.keyboard.press("Enter");
      await expect(email).toBeFocused();
      await expect(email).toHaveAttribute("aria-invalid", "true");
      await expect(email).toHaveAccessibleDescription("Email or password is incorrect.");
      await expect(password).toHaveAccessibleDescription("Email or password is incorrect.");
      await page.keyboard.press("Control+a");
      await page.keyboard.type("correct@example.test");
      await expect(email).toHaveValue("correct@example.test");
    });

    for (const [scenario, field] of [["anonymous", "Email"], ["signup", "Email"], ["signup-agreements", "Name"], ["forgot-password", "Email"], ["reset-password", "New password"]]) {
      test(`first editable auth field receives typing on ${scenario}`, async ({ page }) => {
        await openScenario(page, scenario);
        const input = page.getByLabel(field, { exact: true });
        await expect(input).toBeFocused();
        await page.keyboard.type("keyboard");
        await expect(input).toHaveValue("keyboard");
      });
    }

    test("development sign-in focuses its first field", async ({ page }) => {
      await page.route("**/v1/auth/config", route => route.fulfill({ json: { ...authentication, provider: "development", providers: [], password_login: false, development_login: true } }));
      await page.goto("/__review/scenario/anonymous");
      const name = page.getByRole("textbox", { name: "Name", exact: true });
      await expect(name).toBeFocused();
      await page.keyboard.press("Control+a");
      await page.keyboard.type("keyboard");
      await expect(name).toHaveValue("keyboard");
    });
  });
}

for (const colorScheme of ["light", "dark"] as const) test.describe(`forced-colors palette ${colorScheme}`, () => {
  test.use({ colorScheme });
  test("selection keeps a full-perimeter system-color outline as arrow keys move it", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openScenario(page, "typical-account");
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    const first = palette.getByRole("option", { selected: true });
    const firstId = await first.getAttribute("id");
    const highlight = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "Highlight";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    for (let step = 0; step < 2; step++) {
      const selected = palette.getByRole("option", { selected: true });
      await expect(selected).toHaveCSS("outline-style", "solid");
      await expect(selected).toHaveCSS("outline-width", "1px");
      await expect(selected).toHaveCSS("outline-color", highlight);
      await expect(selected).toHaveCSS("outline-offset", "-1px");
      if (step === 0) await page.keyboard.press("ArrowDown");
    }
    await expect(page.locator(`[id="${firstId}"]`)).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(`[id="${firstId}"]`)).toHaveCSS("outline-style", "none");
    await expect(palette.getByRole("combobox")).toBeFocused();
  });
});

for (const colorScheme of ["light", "dark"] as const) test.describe(`short viewport palette ${colorScheme}`, () => {
  test.use({ viewport: { width: 844, height: 390 }, colorScheme });
  test("result navigation scrolls the pane, not the focused search out of view", async ({ page }, testInfo) => {
    await openScenario(page, "typical-account");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Commands", exact: true });
    const input = palette.getByRole("combobox");
    await palette.evaluate(dialog => Promise.all(dialog.getAnimations().map(animation => animation.finished)));
    const geometry = () => palette.evaluate(dialog => {
      const input = dialog.querySelector("input")!.getBoundingClientRect();
      const pane = dialog.querySelector(".mdbase-command-results")!;
      return { top: input.top, bottom: input.bottom, scroll: dialog.scrollTop, height: pane.getBoundingClientRect().height, paneScroll: pane.scrollTop };
    });
    const before = await geometry();
    for (let index = 0; index < 12; index++) await page.keyboard.press("ArrowDown");
    await expect(input).toBeFocused();
    const after = await geometry();
    expect(after.scroll).toBe(0);
    expect(after.top).toBeGreaterThanOrEqual(0);
    expect(after.bottom).toBeLessThanOrEqual(390);
    expect(after.height).toBeLessThan(380);
    expect(after.height).toBe(before.height);
    expect(after.paneScroll).toBeGreaterThan(0);
    await page.keyboard.type("coastal");
    expect((await geometry()).height).toBe(before.height);
    await testInfo.attach("short-palette-geometry", { body: JSON.stringify({ before, after }), contentType: "application/json" });
  });
});

for (const width of [1440, 390]) for (const colorScheme of ["light", "dark"] as const) test.describe(`shared tooltips ${width} ${colorScheme}`, () => {
  test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme });

  test("hover waits 400ms, hands off immediately and never changes button layout or blocks its clicks", async ({ page }, testInfo) => {
    await openScenario(page, "typical-account");
    await page.clock.install({ time: new Date(clock) });
    await page.clock.pauseAt(new Date(new Date(clock).getTime() + 1000));
    const actions = page.getByRole("button", { name: /^Actions for / });
    const first = actions.nth(0), second = actions.nth(1);
    const firstBounds = await first.boundingBox();
    await first.hover();
    await page.clock.runFor(399);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.clock.runFor(1);
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toHaveText(await first.getAttribute("aria-label") as string);
    expect(await first.boundingBox()).toEqual(firstBounds);
    await expect(tooltip).toHaveCSS("pointer-events", "auto");
    await expect(first).not.toHaveAttribute("aria-describedby");
    await expect(first).toHaveAccessibleDescription("");
    await expect(first).not.toHaveAttribute("title");
    const bounds = (await tooltip.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(width === 390 ? 836 : 892);
    const image = testInfo.outputPath("tooltip.png");
    await page.screenshot({ path: image });
    await testInfo.attach("tooltip", { path: image, contentType: "image/png" });
    await second.hover();
    await expect(tooltip).toHaveText(await second.getAttribute("aria-label") as string);
    await page.evaluate(() => document.addEventListener("keydown", event => {
      if (event.key === "Escape") Object.assign(window, { tooltipEscape: { prevented: event.defaultPrevented, reached: true } });
    }));
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "tooltipEscape"))).toBeUndefined();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => Reflect.get(window, "tooltipEscape"))).toEqual({ prevented: false, reached: true });
    await page.mouse.move(0, 0);
    await page.clock.runFor(801);
    await first.hover();
    await page.clock.runFor(399);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(tooltip).toBeVisible();
    await first.click();
    await expect(tooltip).toHaveCount(0);
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(first).toBeFocused();
    await page.clock.runFor(120);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await testInfo.attach("tooltip-layout", { body: JSON.stringify({ firstBounds, tooltip: bounds, delay: 400, warmDelay: 0 }), contentType: "application/json" });
  });

  test("keyboard focus is immediate, blur and press dismiss, and Escape closes the tooltip before its dialog", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openScenario(page, "typical-account");
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    await keyTo(page, actions, "Tab");
    await expect(page.getByRole("tooltip")).toHaveText(await actions.getAttribute("aria-label") as string);
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(actions).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(actions).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("c");
    const dialog = page.getByRole("dialog", { name: "Add collection", exact: true });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await keyTo(page, close, "Tab");
    await expect(close).toBeFocused();
    await expect(close).toHaveAttribute("aria-keyshortcuts", "Escape");
    await expect(close).toHaveAccessibleName("Close");
    await expect(close).toHaveAccessibleDescription("Escape");
    await expect(page.getByRole("tooltip").locator("kbd")).toHaveText("Escape");
    await expect(page.getByRole("tooltip")).toHaveCSS("transition-property", "none");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await expect(close).not.toHaveAttribute("aria-describedby");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the pointer can cross the gap and hover the bubble without a focus stop", async ({ page }) => {
    await openScenario(page, "typical-account");
    await page.clock.install({ time: new Date(clock) });
    await page.clock.pauseAt(new Date(new Date(clock).getTime() + 1000));
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    await keyTo(page, actions, "Tab");
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await actions.hover();
    const button = (await actions.boundingBox())!;
    const bubble = (await tooltip.boundingBox())!;
    await page.mouse.move(button.x + button.width / 2, button.y + button.height + 3);
    await page.clock.runFor(80);
    await expect(tooltip).toBeVisible();
    await page.mouse.move(bubble.x + bubble.width / 2, bubble.y + bubble.height / 2);
    await page.clock.runFor(500);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).not.toHaveAttribute("tabindex");
    await expect(actions).toBeFocused();
    await actions.hover();
    await page.clock.runFor(500);
    await expect(tooltip).toBeVisible();
    await tooltip.hover();
    await page.mouse.move(0, 0);
    await page.clock.runFor(119);
    await expect(tooltip).toBeVisible();
    await page.clock.runFor(1);
    await expect(tooltip).toHaveCount(0);
  });

  for (const phase of ["pending", "visible"]) test(`${phase} tooltips cancel when the trigger is disabled or hidden`, async ({ page }) => {
    await openScenario(page, "typical-account");
    await page.clock.install({ time: new Date(clock) });
    await page.clock.pauseAt(new Date(new Date(clock).getTime() + 1000));
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    const tooltip = page.getByRole("tooltip");
    for (const attribute of ["disabled", "hidden", "style", "ancestor-hidden", "inert"]) {
      await actions.hover();
      await page.clock.runFor(phase === "pending" ? 200 : 400);
      await expect(tooltip).toHaveCount(phase === "pending" ? 0 : 1);
      await actions.evaluate((button, attribute) => {
        if (attribute === "ancestor-hidden") button.parentElement!.hidden = true;
        else button.setAttribute(attribute, attribute === "style" ? "visibility: hidden" : "");
      }, attribute);
      await page.clock.runFor(401);
      await expect(tooltip).toHaveCount(0);
      await actions.evaluate((button, attribute) => {
        if (attribute === "ancestor-hidden") button.parentElement!.hidden = false;
        else button.removeAttribute(attribute);
      }, attribute);
      await page.mouse.move(0, 0);
      await page.clock.runFor(801);
    }
  });

  for (const phase of ["pending", "visible"]) test(`${phase} tooltips cancel on scroll, resize and window blur`, async ({ page }) => {
    await openScenario(page, "typical-account");
    await page.clock.install({ time: new Date(clock) });
    await page.clock.pauseAt(new Date(new Date(clock).getTime() + 1000));
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    await actions.evaluate(button => {
      document.documentElement.style.overflow = "auto";
      document.body.style.minHeight = "2000px";
      button.closest<HTMLElement>(".connect-collection-row")!.style.viewTransitionName = "none";
      Object.assign(button.style, { position: "fixed", top: "100px", left: "100px", zIndex: "9999" });
    });
    for (const event of ["scroll", "resize", "blur"]) {
      await actions.hover();
      await page.clock.runFor(phase === "pending" ? 200 : 400);
      await expect(page.getByRole("tooltip")).toHaveCount(phase === "pending" ? 0 : 1);
      if (event === "scroll") {
        await page.mouse.wheel(0, 200);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        expect(await actions.evaluate(button => button.matches(":hover"))).toBe(true);
      } else if (event === "resize") {
        const viewport = page.viewportSize()!;
        await page.setViewportSize({ ...viewport, height: viewport.height - 10 });
      } else await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.clock.runFor(401);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await page.mouse.move(0, 0);
      await page.clock.runFor(801);
    }
  });

  test("a pending hover is cancelled on leave, Escape and outside press", async ({ page }) => {
    await openScenario(page, "typical-account");
    await page.clock.install({ time: new Date(clock) });
    await page.clock.pauseAt(new Date(new Date(clock).getTime() + 1000));
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    for (const cancel of ["leave", "escape", "press"]) {
      await actions.hover();
      await page.clock.runFor(200);
      if (cancel === "leave") await page.mouse.move(0, 0);
      else if (cancel === "escape") await page.keyboard.press("Escape");
      else await page.getByRole("heading", { level: 1 }).click();
      await page.clock.runFor(401);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await page.mouse.move(0, 0);
    }
  });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) test.describe(`long tooltip ${viewport.width}`, () => {
  test.use({ viewport });
  test("wraps a long collection label inside the viewport without moving its trigger", async ({ page }) => {
    const name = "Collection with a long name ".repeat(7).trim();
    await page.route("**/v1/me", async route => {
      const response = await route.fetch();
      const overview = await response.json();
      overview.collections[0].display_name = name;
      await route.fulfill({ response, json: overview });
    });
    await openScenario(page, "typical-account");
    const trigger = page.getByRole("button", { name: `Actions for ${name}`, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await trigger.hover();
    const before = await trigger.boundingBox();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(`Actions for ${name}`);
    const bounds = (await tooltip.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(await trigger.boundingBox()).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
  });
});

for (const colorScheme of ["light", "dark"] as const) test.describe(`touch has no tooltips ${colorScheme}`, () => {
  test.use({ viewport: { width: 390, height: 844 }, colorScheme, hasTouch: true });
  test("touch opens action menus and navigation without showing a tooltip", async ({ page }) => {
    await openScenario(page, "typical-account");
    await page.getByRole("button", { name: /^Actions for / }).first().tap();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.getByRole("heading", { level: 1 }).tap();
    await page.getByRole("button", { name: "Open menu", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "Navigation", exact: true });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });
});

for (const reducedMotion of ["no-preference", "reduce"] as const) test.describe(`tooltip motion ${reducedMotion}`, () => {
  test.use({ reducedMotion });
  test("uses only the shared 120ms opacity fade, or no animation under reduced motion", async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion });
    await openScenario(page, "typical-account");
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) return;
        getComputedStyle(tooltip).opacity;
        Object.assign(window, { tooltipMotion: tooltip.getAnimations().map(animation => ({
          property: animation instanceof CSSTransition ? animation.transitionProperty : animation.id,
          duration: animation.effect!.getTiming().duration
        })) });
        observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    const actions = page.getByRole("button", { name: /^Actions for / }).first();
    await keyTo(page, actions, "Tab");
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    const animations = await page.evaluate(() => Reflect.get(window, "tooltipMotion"));
    expect(animations).toEqual(reducedMotion === "reduce" ? [] : [{ property: "opacity", duration: 120 }]);
    await expect(tooltip).toHaveCSS("opacity", "1");
    await testInfo.attach("tooltip-motion", { body: JSON.stringify(animations), contentType: "application/json" });
  });
});
