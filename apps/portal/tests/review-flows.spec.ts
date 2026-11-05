import { expect, openScenario, test } from "./review/fixture";
import { authorizationId, pairingId } from "./review/scenarios.mjs";

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

test("grant waits for acknowledged status and resolves stripes to a check", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  let approved = false;
  await page.route(`**/v1/authorization-requests/${authorizationId}/status`, route => route.fulfill({ json: { status: approved ? "approved" : "pending" } }));
  await openScenario(page, "authorization");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Collection", exact: true })).toBeFocused();
  await expect(page.getByText(/All permissions listed below are required/)).toHaveCount(0);
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow access", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get("/v1/me")).json()).pending_authorizations.length).toBe(1);
  await page.getByRole("button", { name: "Review access", exact: true }).click();
  const reviewHeader = await page.locator(".request-identity").elementHandle();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByText("The application does not have access yet.", { exact: false })).toBeVisible();
  await expect(page.locator(".grant-moment")).toHaveCount(0);
  expect(await reviewHeader!.evaluate(element => element.isConnected && getComputedStyle(element).position === "sticky")).toBe(true);
  approved = true;
  await expect(page.getByRole("heading", { name: "TaskNotes can now use Field research", exact: true })).toBeVisible();
  await page.evaluate(() => document.getAnimations().forEach(animation => animation.pause()));
  for (const time of [0, 60, 120, 180, 240, 300]) {
    await page.evaluate(time => document.getAnimations().forEach(animation => { animation.currentTime = time; }), time);
    const path = testInfo.outputPath(`grant-${time}ms.png`);
    await page.locator(".grant-moment").screenshot({ path, animations: "allow" });
    await testInfo.attach(`grant-${time}ms`, { path, contentType: "image/png" });
    if (time === 0) await expect(page.locator(".grant-stripes")).toHaveCSS("opacity", "1");
    if (time === 300) {
      await expect(page.locator(".grant-stripes")).toHaveCSS("opacity", "0");
      await expect(page.locator(".grant-mark > svg:last-child path")).toHaveCSS("stroke-dashoffset", "0px");
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openScenario(page, "authorization-approved");
  await expect(page.locator(".grant-stripes")).toHaveCSS("opacity", "0");
  expect(await page.locator(".grant-moment").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
});

test("an expired session says so and keeps the destination", async ({ page }) => {
  await openScenario(page, "session-expired");
  await expect(page.getByRole("status").filter({ hasText: "Your session expired." })).toBeVisible();
  expect(new URL(new URL(page.url()).searchParams.get("return_to")!).pathname).toBe("/account");
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
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
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
    await expect(dialog.getByRole("textbox")).toBeFocused();
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
  await page.getByRole("button", { name: /^Hosted by mdbase/ }).click();
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
  await page.getByRole("button", { name: "Revoke application", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await page.route("**/v1/grants/revoke-batch", async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ status: 503, json: { error: { message: "Reader access could not be revoked. Try again." } } });
  });
  const grants = page.locator(".connect-grant");
  const count = await grants.count();
  await dialog.getByRole("button", { name: "Revoke application", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Revoking access…" })).toHaveAttribute("aria-busy", "true");
  await expect(grants).toHaveCount(count);
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revoke application", exact: true })).toBeEnabled();
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

test("rename survives navigation and reload", async ({ page }) => {
  await openScenario(page, "collection-storage");
  await page.getByRole("button", { name: "Actions for Shared research library" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Rename Shared research library" }).fill("Coastal research library");
  const saved = page.waitForResponse(response => response.request().method() === "PATCH" && new URL(response.url()).pathname === "/v1/hosted/collections/hosted-0");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
  if (await page.getByRole("button", { name: "Open menu" }).isVisible()) await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coastal research library", exact: true })).toBeVisible();
});

test("signed-out pairing signs in locally and remembers approval", async ({ page }) => {
  await openScenario(page, "pairing-signed-out");
  await page.getByRole("button", { name: "Continue with email", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("maya@chen.example");
  await page.getByLabel("Password", { exact: true }).fill("review-only-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await page.getByRole("button", { name: "Open Reader with Field research", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/v1/pairing-requests/${pairingId}`)).json()).pairing.approved_at).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reader can now use Field research", exact: true })).toBeVisible();
});

test("create-new pairing creates a collection and persists it", async ({ page }) => {
  await openScenario(page, "pairing-create-new");
  await page.getByRole("button", { name: "Open Reader with Reader highlights", exact: true }).click();
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

test("account session revocation sticks after reload", async ({ page }) => {
  await openScenario(page, "account-sessions");
  await page.getByRole("button", { name: "Sign out other sessions", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get("/v1/account/sessions")).json()).sessions.length).toBe(1);
  await page.reload();
  await expect(page.getByText("Studio Chrome", { exact: true })).toBeVisible();
  await expect(page.getByText("Travel Safari", { exact: true })).toHaveCount(0);
});

test("signup creates the starter collection and hands off to the configured Editor", async ({ page, baseURL }) => {
  await page.route("http://127.0.0.1:4814/?demo=300", route => route.fulfill({ contentType: "text/html", body: "<h1>Editor handoff</h1>" }));
  await openScenario(page, "signup-agreements");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Maya Chen");
  await page.getByLabel("Password", { exact: true }).fill("a-long-local-review-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("a-long-local-review-password");
  await page.getByRole("checkbox", { name: /I agree to the/ }).check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4814/?demo=300");
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
