import { expect, type Locator, type Page } from "@playwright/test";
import { installAuthRoutes, test } from "./auth-portal";

// Fixed Date without stopping timers/RAF: saves, lazy workspaces and font loading
// still run normally. The generated collection is deterministic for this instant.
const fixedTime = new Date("2026-10-03T12:00:00.000Z");
const modes = [
  { name: "light-desktop", theme: "light", width: 1440, height: 900 },
  { name: "dark-desktop", theme: "dark", width: 1440, height: 900 },
  { name: "light-mobile", theme: "light", width: 390, height: 844 },
  { name: "dark-mobile", theme: "dark", width: 390, height: 844 }
] as const;

test.use({ locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });

async function openDemo(page: Page, surface = "notes") {
  await page.goto(`?demo=300&surface=${surface}`);
  if (surface === "notes") await expect(page.getByRole("textbox", { name: "Note title", exact: true }))
    .toHaveValue("The shape of useful tools");
}

async function settle(page: Page) {
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const mode of modes) {
  test(`visual baseline: ${mode.name}`, async ({ page, authPortal }) => {
    test.setTimeout(60_000);
    const mobile = mode.width === 390;
    await page.setViewportSize({ width: mode.width, height: mode.height });
    await page.emulateMedia({ colorScheme: mode.theme });
    await page.clock.setFixedTime(fixedTime);
    await page.addInitScript((theme) => {
      localStorage.clear(); // Last-note/draft/history/layout persistence must not leak between views.
      sessionStorage.clear();
      localStorage.setItem("mdbase:theme", theme);
    }, mode.theme);
    const capture = async (view: string, target?: Locator) => {
      await settle(page);
      // No broad masks: changing labels, missing fonts, controls and embeds are regressions.
      const options = { animations: "disabled" as const, caret: "hide" as const, scale: "css" as const,
        threshold: 0.2, maxDiffPixelRatio: 0.001 };
      if (target) await expect(target).toHaveScreenshot(`${mode.name}-${view}.png`, options);
      else await expect(page).toHaveScreenshot(`${mode.name}-${view}.png`, options);
    };

    await openDemo(page);
    await expect(page.getByRole("img", { name: "A durable piece of frontmatter" })).toBeVisible();
    await capture("note-view");

    if (mobile) await page.getByRole("button", { name: "Back to notes", exact: true }).click();
    const list = page.getByRole("listbox", { name: "Collection notes and files" });
    await list.getByRole("option", { name: /Garden notes 2/ }).click({ modifiers: ["Control"] });
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await capture("selected-list", mobile ? undefined : page.locator(".note-list-pane"));

    if (mobile) await page.getByRole("button", { name: "Collections", exact: true }).click();
    const rail = page.getByRole("complementary", { name: "Collection navigation" });
    await expect(rail.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");
    await capture("rail", mobile ? undefined : rail);

    await openDemo(page);
    if (mobile) {
      await page.getByRole("button", { name: "Back to notes", exact: true }).click();
      await page.getByRole("button", { name: "Collections", exact: true }).click();
    }
    await page.getByRole("button", { name: "Types (1)" }).click();
    await page.getByRole("option", { name: /^note/ }).click();
    await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
    await expect(page.locator(".type-heading-title .ph")).toHaveCSS("font-family", /Phosphor/);
    await page.getByRole("heading", { name: "Fields", exact: true }).click();
    await capture("types");

    await openDemo(page, "settings");
    await expect(page.getByRole("main", { name: "Editor settings" })).toBeVisible();
    await capture("settings");

    await openDemo(page);
    if (mobile) await page.getByRole("button", { name: "Back to notes", exact: true }).click();
    await page.getByRole("option", { name: /A quiet interface 3/ }).click();
    if (mobile) {
      await page.getByRole("button", { name: "More note actions" }).click();
      await page.getByRole("menuitem", { name: "Note properties", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Note properties" })).toBeVisible();
    } else {
      await page.getByRole("button", { name: "Note properties", exact: true }).click();
      await expect(page.getByRole("complementary", { name: "Note properties" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Note properties" })).toHaveCount(0);
    }
    await expect(page.getByRole("tab", { name: "Fields", exact: true })).toBeVisible();
    await capture("properties"); // Docked on desktop, the accessible overlay at 390px.

    await openDemo(page);
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox", { name: "Find a note or action" }).fill(">");
    await expect(page.getByRole("option").first()).toContainText("New note");
    await expect(page.locator(".quick-open-command small").first()).toHaveCSS("font-family", /Atkinson/);
    await capture("quick-open");
    await page.keyboard.press("Escape");

    if (mobile) {
      await page.getByRole("button", { name: "More note actions" }).click();
      await page.getByRole("menuitem", { name: "New note", exact: true }).click();
    } else await page.getByRole("button", { name: "New note", exact: true }).click();
    const composer = page.getByRole("main", { name: "Create note" });
    await expect(composer).toBeVisible();
    await composer.getByRole("textbox", { name: "Title", exact: true }).fill("A quieter way to work");
    await composer.getByRole("textbox", { name: "Note body", exact: true }).fill("A fresh note begins with a little space.");
    await expect(composer.getByRole("button", { name: "Create note", exact: true })).toBeEnabled();
    await capture("composer");
    // Leave no draft before navigating across origins (no beforeunload dialogs).
    await composer.getByRole("textbox", { name: "Title", exact: true }).fill("");
    await composer.getByRole("textbox", { name: "Note body", exact: true }).fill("");
    await composer.getByRole("button", { name: "Cancel", exact: true }).click();

    await installAuthRoutes(page, authPortal);
    await page.goto(`connect?server=${encodeURIComponent(authPortal)}`);
    await expect(page).toHaveURL(`${authPortal}/login`);
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
    await expect(page.locator(".provider-divider")).toHaveCount(1);
    await capture("connect-signin");
  });
}
