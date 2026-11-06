import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./review/fixture";
import { authentication, authorizationId } from "./review/scenarios.mjs";

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
