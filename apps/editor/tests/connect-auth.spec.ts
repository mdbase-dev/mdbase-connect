import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { authentication, googleFixture, installAuthRoutes, test } from "./auth-portal";
import { chooseOption } from "./select";

// /connect redirects unauthenticated accounts to the transactional portal.
let portalOrigin: string;

async function expectAccessible(page: Page) {
  // Audit settled control states, not interpolated theme/disabled colors.
  await page.locator(".minimal-auth-shell").evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
  });
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
}

test.beforeEach(async ({ page, authPortal }) => {
  portalOrigin = authPortal;
  await installAuthRoutes(page, authPortal);
});

test("Connect opens one themed, accessible auth column at desktop and 390px", async ({ page }) => {
  await page.goto(`connect?server=${encodeURIComponent(portalOrigin)}`);
  await expect(page).toHaveURL(`${portalOrigin}/login`);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  await expect(page.locator(".provider-divider")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveText("Sign in");
  await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  expect(await page.locator(".minimal-auth-shell").evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Atkinson Hyperlegible Next Variable");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveClass(/mdbase-button is-primary/);
  for (const theme of ["light", "dark"] as const) {
    await chooseOption(page.getByRole("combobox", { name: "Color theme" }), theme);
    await expect(page.locator(".google-button")).toHaveAttribute("data-theme", theme === "dark" ? "filled_black" : "outline");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const layout = await page.locator(".minimal-auth-shell").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { center: rect.left + rect.width / 2, width: rect.width };
      });
      expect(Math.abs(layout.center - width / 2)).toBeLessThan(1);
      expect(layout.width).toBeLessThanOrEqual(400);
      const primary = page.getByRole("button", { name: "Sign in", exact: true });
      expect(await primary.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await expect(primary).toHaveCSS("text-decoration-line", "none");
      await expectAccessible(page);
    }
  }
});

test("native validation is inline, focuses the first invalid field, and clears on correction", async ({ page }) => {
  await page.goto(`${portalOrigin}/login`);
  const email = page.locator('input[autocomplete="username"]');
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".auth-field-error").first()).toBeVisible();
  await email.fill("not-an-email");
  await email.press("Tab");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await email.fill("fixture@example.com");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  await page.locator('input[autocomplete="current-password"]').fill("fixture password");
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${portalOrigin}/v1/auth/password/login`, async (route) => {
    requests++;
    await pending;
    await route.fulfill({ status: 401, json: { error: { message: "Email or password is incorrect." } } });
  });
  await page.locator('input[autocomplete="current-password"]').press("Enter");
  const submit = page.getByRole("button", { name: "Signing in…" });
  await expect(submit).toBeDisabled();
  await expect(page.locator(".password-auth-form")).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.getByRole("alert")).toHaveText("Email or password is incorrect.");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(requests).toBe(1);
});

test("Google reserves a disabled control while loading and retries script failure", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("https://accounts.google.com/**", async (route) => { await pending; await route.abort(); });
  await page.goto(`${portalOrigin}/login`, { waitUntil: "domcontentloaded" });
  const loading = page.getByRole("button", { name: "Continue with Google" });
  await expect(loading).toBeDisabled();
  await expect(page.locator(".google-button")).toHaveAttribute("inert", "");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".auth-spinner")).toHaveCSS("animation-name", "none");
  await expect(page.getByText("Preparing Google sign-in…")).toHaveCount(0);
  const before = await page.locator(".google-provider").boundingBox();
  release();
  const retry = page.getByRole("button", { name: "Retry Google sign-in" });
  await expect(retry).toBeEnabled();
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({ contentType: "application/javascript", body: googleFixture }));
  await retry.click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await page.locator(".google-provider").boundingBox())?.height).toBe(before?.height);
  await page.route(`${portalOrigin}/auth/google/callback`, (route) => route.fulfill({ status: 401, json: { error: { message: "Sign-in expired. Try again." } } }));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("alert")).toHaveText("Sign-in expired. Try again.");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
});

test("cancelled authorization remains visible after auth configuration loads", async ({ page }) => {
  await page.goto(`${portalOrigin}/login?auth_error=cancelled&return_to=/authorize/fixture`);
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Sign-in was cancelled");
});

test("signup and recovery use the same column and announce email delivery without account disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, action] of [["signup", "Send verification link"], ["forgot-password", "Send reset link"]]) {
    await page.goto(`${portalOrigin}/${path}`);
    await chooseOption(page.getByRole("combobox", { name: "Color theme" }), "dark");
    await expect(page.locator(".minimal-auth-shell")).toBeVisible();
    await expect(page.locator(".provider-divider")).toHaveCount(path === "signup" ? 1 : 0);
    await page.getByLabel("Email", { exact: true }).fill("fixture@example.com");
    await page.getByRole("button", { name: action }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("If");
    await expect(page.locator(".password-auth-form")).toHaveCount(0);
    await expectAccessible(page);
  }
});

test("reset and verified signup validate matching passwords inline", async ({ page }) => {
  await page.route(`${portalOrigin}/v1/auth/password/signup/verification`, (route) => route.fulfill({ json: { verification: { email: "fixture@example.com" } } }));
  for (const [path, submit, confirm] of [
    ["reset-password#reset=fixture-reset", "Change password", "Confirm new password"],
    ["signup#verification=fixture-verification", "Create account", "Confirm password"]
  ]) {
    await page.goto(`${portalOrigin}/${path}`);
    await page.setViewportSize({ width: 390, height: 844 });
    const password = page.locator('input[autocomplete="new-password"]').first();
    await password.fill("short");
    await password.press("Tab");
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await password.fill("a valid fixture password");
    const confirmation = page.getByLabel(confirm, { exact: true });
    await confirmation.fill("a different fixture password");
    if (path.startsWith("signup")) {
      await page.getByLabel("Name", { exact: true }).fill("Fixture Person");
      await page.getByRole("checkbox", { name: /I agree/ }).check();
    }
    await page.getByRole("button", { name: submit, exact: true }).click();
    await expect(confirmation).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
    await confirmation.fill("a valid fixture password");
    await expect(confirmation).not.toHaveAttribute("aria-invalid", "true");
    await expectAccessible(page);
    if (path.startsWith("reset")) {
      await page.getByRole("button", { name: submit }).click();
      await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();
      await expect(page.getByRole("status")).toContainText("other browser sessions");
    }
  }
});

test("configuration failure stays in the auth shell and offers a working retry", async ({ page }) => {
  await page.route(`${portalOrigin}/v1/auth/config`, (route) => route.fulfill({ status: 503, json: { error: { message: "Sign-in is temporarily unavailable." } } }));
  await page.goto(`${portalOrigin}/login`);
  await expect(page.getByRole("heading", { name: "Couldn’t connect" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Sign-in is temporarily unavailable.");
  await page.route(`${portalOrigin}/v1/auth/config`, (route) => route.fulfill({ json: authentication }));
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});

test("unavailable and invalid-link siblings keep one heading and a recovery action", async ({ page }) => {
  await page.route(`${portalOrigin}/v1/auth/config`, (route) => route.fulfill({ json: { ...authentication, password_recovery: false } }));
  await page.goto(`${portalOrigin}/forgot-password`);
  await expect(page.getByText(/Password recovery is temporarily unavailable/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Return to sign in" })).toBeVisible();
  for (const path of ["reset-password", "signup#invitation=fixture-invitation", "unsubscribe"]) {
    await page.goto(`${portalOrigin}/${path}`);
    await expect(page.locator(".minimal-auth-shell h1")).toHaveCount(1);
    await expect(page.locator(".minimal-auth-shell h1")).toContainText("can’t be opened");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
