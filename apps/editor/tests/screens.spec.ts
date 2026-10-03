import { expect, type Page } from "@playwright/test";
import { installAuthRoutes, test } from "./auth-portal";

for (const width of [1440, 390]) {
  test(`direct Types entry loads source and preserves a local draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("?demo=300&surface=types");
    await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("textbox", { name: "title field name" }).fill("summary");
    await page.getByRole("heading", { name: "Fields", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "summary field name" })).toHaveValue("summary");
    await expect(page.getByRole("button", { name: "Review changes", exact: true })).toBeEnabled();
  });
}

for (const width of [1440, 390]) {
  test(`quiet screen controls stay aligned and operable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("?demo=300&surface=settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    const geometry = await page.locator(".settings-document").evaluate((document) => {
      const section = document.querySelector(".settings-intro")!;
      const heading = section.querySelector("h2")!.getBoundingClientRect();
      const description = section.querySelector("p")!.getBoundingClientRect();
      return {
        stacked: description.top >= heading.bottom,
        facts: [...document.querySelectorAll(".fact-row")].filter((row) => row.checkVisibility()).map((row) => row.getBoundingClientRect().height),
        preferences: [...document.querySelectorAll(".setting-row:not(.connection-action)")].map((row) => row.getBoundingClientRect().height)
      };
    });
    expect(geometry.stacked).toBe(true);
    expect(geometry.facts.filter((height) => height > 0).every((height) => height === 44)).toBe(true);
    expect(geometry.preferences.every((height) => height >= 64)).toBe(true);
    const vim = page.getByRole("switch", { name: "Vim key bindings" });
    await vim.focus();
    await page.keyboard.press("Space");
    await expect(vim).toHaveAttribute("aria-checked", "true");
    if (width === 390) await page.getByRole("button", { name: "Back to collection" }).click();
    await page.getByRole("button", { name: "Types (1)" }).click();
    await page.getByRole("option", { name: /note/ }).click();
    await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
    await expect(page.locator(".type-inspector-bar .mdbase-save-notice")).toHaveCount(0);
    // Healthy saves are silent; exercise the slow-save layout with a temporary
    // shared notice fixture. TypeInspector unit tests cover its delayed display.
    const notice = await page.locator(".type-inspector-bar").evaluate((bar) => {
      const fixture = document.createElement("span");
      fixture.className = "mdbase-save-notice";
      fixture.textContent = "Saving…";
      bar.append(fixture);
      const rect = bar.getBoundingClientRect();
      const status = fixture.getBoundingClientRect();
      fixture.remove();
      return { gap: rect.right - status.right, width: status.width };
    });
    expect(notice.gap).toBeLessThan(25);
    expect(notice.width).toBeLessThan(90);
    expect(await page.locator(".visual-field-name input").first().evaluate((input) => getComputedStyle(input).fontFamily)).toContain("Atkinson");
    const options = page.getByRole("button", { name: "title field options" });
    await options.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Remove title field" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(options).toBeFocused();
    await page.getByRole("textbox", { name: "title field name" }).fill("summary");
    await page.getByRole("heading", { name: "Fields", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review changes" })).toBeEnabled();
    await expect(page.locator(".type-inspector")).toHaveJSProperty("scrollWidth", await page.locator(".type-inspector").evaluate((element) => element.clientWidth));
  });
}

async function openDemoForLayout(page: Page, surface = "notes") {
  await page.goto(`?demo=300&surface=${surface}`);
  if (surface === "notes") await expect(page.getByRole("textbox", { name: "Note title", exact: true }))
    .toHaveValue("The shape of useful tools");
}

async function expectReadyLayout(page: Page) {
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => [...document.fonts].some((font) =>
    font.family.includes("Atkinson") && font.status === "loaded"))).toBe(true);
  await expect(page.locator("body")).toHaveCSS("font-family", /Atkinson/);
  await expect.poll(() => page.locator("img:visible").evaluateAll((images) =>
    images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.locator("img:visible").evaluateAll((images) => Promise.all(images.map((image) => (image as HTMLImageElement).decode())));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.describe("responsive themed view readiness", () => {
  test.use({ locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  const modes = [
    { name: "light-desktop", theme: "light", width: 1440, height: 900 },
    { name: "dark-desktop", theme: "dark", width: 1440, height: 900 },
    { name: "light-mobile", theme: "light", width: 390, height: 844 },
    { name: "dark-mobile", theme: "dark", width: 390, height: 844 }
  ] as const;

  for (const mode of modes) {
    test(`views load without horizontal overflow in ${mode.name}`, async ({ page, authPortal }) => {
      test.setTimeout(60_000);
      const mobile = mode.width === 390;
      await page.setViewportSize({ width: mode.width, height: mode.height });
      await page.emulateMedia({ colorScheme: mode.theme });
      await page.clock.setFixedTime(new Date("2026-10-03T12:00:00.000Z"));
      await page.addInitScript((theme) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem("mdbase:theme", theme);
      }, mode.theme);
      const checkView = async (view: string) => test.step(`${view} is ready and fits the viewport`, async () => {
        await expect(page.locator("html")).toHaveAttribute("data-theme", mode.theme);
        await expectReadyLayout(page);
      });

      await openDemoForLayout(page);
      await expect(page.getByRole("textbox", { name: "Note body", exact: true })).toBeEditable();
      await expect(page.getByRole("img", { name: "A durable piece of frontmatter" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Linked from", exact: true })).toBeVisible();
      await checkView("Note with image and footer");

      if (mobile) await page.getByRole("button", { name: "Back to notes", exact: true }).click();
      const list = page.getByRole("listbox", { name: "Collection notes and files" });
      await list.getByRole("option", { name: /Garden notes 2/ }).click({ modifiers: ["Control"] });
      await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
      await checkView("Selected list");

      if (mobile) await page.getByRole("button", { name: "Collections", exact: true }).click();
      const rail = page.getByRole("complementary", { name: "Collection navigation" });
      await expect(rail).toBeVisible();
      await expect(rail.getByRole("group", { name: "Folders" })).toHaveAttribute("aria-busy", "false");
      await checkView("Collection rail");

      await openDemoForLayout(page);
      if (mobile) {
        await page.getByRole("button", { name: "Back to notes", exact: true }).click();
        await page.getByRole("button", { name: "Collections", exact: true }).click();
      }
      await page.getByRole("button", { name: "Types (1)" }).click();
      await page.getByRole("option", { name: /^note/ }).click();
      await expect(page.getByRole("textbox", { name: "title field name" })).toBeVisible();
      await expect(page.locator(".type-heading-title .ph")).toHaveCSS("font-family", /Phosphor/);
      await page.getByRole("heading", { name: "Fields", exact: true }).click();
      await checkView("Types");

      await openDemoForLayout(page, "settings");
      await expect(page.getByRole("main", { name: "Editor settings" })).toBeVisible();
      await checkView("Settings");

      await openDemoForLayout(page);
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
      await checkView("Properties");

      await openDemoForLayout(page);
      await page.keyboard.press("Control+p");
      await page.getByRole("combobox", { name: "Find a note or action" }).fill(">");
      await expect(page.getByRole("option").first()).toContainText("New note");
      await expect(page.locator(".quick-open-command small").first()).toHaveCSS("font-family", /Atkinson/);
      await checkView("Quick open");
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
      await checkView("Composer");
      // Do not leave an unsaved draft before navigating to the local auth portal.
      await composer.getByRole("textbox", { name: "Title", exact: true }).fill("");
      await composer.getByRole("textbox", { name: "Note body", exact: true }).fill("");
      await composer.getByRole("button", { name: "Cancel", exact: true }).click();

      await installAuthRoutes(page, authPortal);
      await page.goto(`connect?server=${encodeURIComponent(authPortal)}`);
      await expect(page).toHaveURL(`${authPortal}/login`);
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
      await expect(page.locator(".provider-divider")).toHaveCount(1);
      await checkView("Connect sign-in");
    });
  }
});
