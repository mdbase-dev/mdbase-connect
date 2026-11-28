import { expect, test } from "@playwright/test";

const fixture = "tests/fixtures/editor-regressions.html";

for (const folder of ["_types", "_mdbase/types", "Schemas/custom", null]) {
  test(`Settings reports the collection's types folder (${folder ?? "missing"})`, async ({ page }) => {
    await page.goto(folder ? `${fixture}?typesFolder=${encodeURIComponent(folder)}` : fixture);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const collection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Collection", exact: true }) });
    await collection.getByText("Details", { exact: true }).click();
    await expect(page.locator(".fact-row").filter({ hasText: "Types folder" })).toContainText(folder ?? "Not reported");
  });
}

test("a Private collection waiting to open explains that it will continue", async ({ page }) => {
  await page.goto(`${fixture}?scenario=private-wait`);
  await expect(page.getByRole("heading", { name: "Waiting for your computer to serve this collection" })).toBeVisible();
  await expect(page.getByText(/this app connects as soon as it can/i)).toBeVisible();
  await page.getByRole("button", { name: "Resume serving" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("review");
});

test("an open Private collection explains a disconnect and keeps the same note open", async ({ page }) => {
  await page.goto(`${fixture}?scenario=private-reconnect`);
  const title = page.getByRole("textbox", { name: "Note title" });
  await expect(title).toHaveValue("review");
  await page.getByRole("button", { name: "Stop serving" }).click();
  const advice = page.getByText(/open the mdbase desktop app on a computer that has it/i);
  await expect(advice).toBeVisible();
  await expect(title).toHaveValue("review");
  await page.getByRole("button", { name: "Resume serving" }).click();
  await expect(advice).toHaveCount(0);
  await expect(title).toHaveValue("review");
});

test("two tabs of the same Editor build share their workspace across reloads", async ({ context, page }) => {
  await context.route("https://connect.mdbase.dev/v1/apps/register", async (route) => {
    const { manifest } = route.request().postDataJSON();
    const digest = "cc".repeat(32);
    await route.fulfill({ headers: { "access-control-allow-origin": "*" }, json: { application: {
      id: "55555555-5555-4555-8555-555555555555",
      name: manifest.name,
      manifest_digest: digest,
      canonical_identity: `bundle:${manifest.id}:sha256:${digest}`,
      family_identity: `bundle:${manifest.id}`,
      distribution: "web",
      application_declaration: manifest
    } } });
  });
  const workspace = (tab: typeof page) => tab.getByText("Saved only in this browser", { exact: true });
  const url = `${fixture}?scenario=tabs`;
  await page.goto(url);
  await expect(workspace(page)).toBeVisible({ timeout: 15_000 });
  const other = await context.newPage();
  await other.goto(url);
  await expect(workspace(other)).toBeVisible();
  await other.reload();
  await expect(workspace(other)).toBeVisible();
  await expect(workspace(page)).toBeVisible();
  await page.reload();
  await expect(workspace(page)).toBeVisible();
  await expect(workspace(other)).toBeVisible();
  await page.close();
  await expect(workspace(other)).toBeVisible();
  const leaders = await other.evaluate(async () =>
    (await navigator.locks.query()).held?.filter(({ name }) => name?.startsWith("mdbn-app-tabs/") && name.endsWith("/leader")).length);
  expect(leaders).toBe(1);
});

test("history recognizes this Editor and describes the earliest external version", async ({ page }) => {
  await page.goto(fixture);
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const history = page.getByRole("complementary", { name: "Version history" });
  await expect(history.getByText("You, in mdbase editor", { exact: true })).toBeVisible();
  await expect(history.getByText("You, on the web", { exact: true })).toBeVisible();
  await expect(history.getByText("Edited outside mdbase")).toBeVisible();
  await expect(history.getByText("This is the earliest version mdbase has for this note.")).toBeVisible();
  await expect(history.getByText(/no longer kept|history goes back/i)).toHaveCount(0);
});

test("closing Properties acknowledges an invalid edit and retains the saved value", async ({ page }) => {
  await page.goto(fixture);
  const properties = page.getByRole("button", { name: "Note properties", exact: true });
  await properties.click();
  const rating = page.getByRole("textbox", { name: "rating" });
  await rating.fill("9");
  await rating.press("Tab");
  await expect(page.getByText("Enter 5 or less.")).toBeVisible();
  await page.getByRole("button", { name: "Close properties" }).click();
  await expect(page.getByText("Invalid property edits were discarded.")).toBeVisible();
  await properties.click();
  await expect(rating).toHaveValue("3");
  await rating.fill("5");
  await rating.press("Tab");
  await page.getByRole("button", { name: "Close properties" }).click();
  await properties.click();
  await expect(rating).toHaveValue("5");
});

test("the self-hosted form reports invalid codes and sends a full pasted code", async ({ page, context, baseURL }) => {
  // The direct SDK requires an HTTPS app origin. Serve the built fixture there
  // through Playwright, using only the local test server for bytes.
  const origin = "https://editor-direct.test";
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href }) });
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const submitted: (string | Buffer)[] = [];
  await page.routeWebSocket("wss://server.example/_mdbase/pair", (socket) => {
    socket.onMessage((message) => {
      submitted.push(message);
      socket.close();
    });
  });
  await page.goto(`${origin}/${fixture}?scenario=pairing`);
  await page.getByLabel("Server address or invitation link").fill("https://server.example");
  const code = page.getByLabel("8-digit pairing code");
  const submit = page.getByRole("button", { name: "Pair and open collection" });
  for (const input of ["", "12345", "12 34 56", "123456789"]) {
    await code.fill(input);
    await submit.click();
    await expect(page.getByRole("alert")).toHaveText("Enter the eight-digit pairing code.");
    await expect(code).toBeFocused();
    await expect(code).toHaveAccessibleDescription("Enter the eight-digit pairing code.");
    expect(submitted).toEqual([]);
  }
  const grouped = "12 34-5678";
  await page.evaluate((text) => navigator.clipboard.writeText(text), grouped);
  await code.selectText();
  await code.press("Control+v");
  await expect(code).toHaveValue(grouped);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await submit.click();
  await expect.poll(() => submitted).toEqual(["12345678"]);
});

for (const reload of [true, false]) {
  test(`an offline edit survives a rejected write in Chromium (reload ${reload})`, async ({ page, context }) => {
    type ReplicaWindow = Window & { offlineFixture: import("@mdbase-dev/sdk/testing").TestApp };
    await page.goto(`${fixture}?scenario=offline-replica`);
    const editor = page.frameLocator('iframe[title="Editor"]');
    const body = editor.getByRole("textbox", { name: "Note body" });
    await expect(body).toHaveText("Base text");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/mdbase-shell-sw.js", { type: "module" });
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.evaluate(() => (window as ReplicaWindow).offlineFixture.replica().setOnline(false));
    await body.fill("Browser offline edit");
    await expect.poll(() => page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith("mdbase-editor:draft:v1:"));
      return key && JSON.parse(localStorage.getItem(key)!).awaitingSync;
    })).toBe(true);
    if (reload) {
      const navigation = page.waitForEvent("framenavigated", frame => frame.url().endsWith("?scenario=offline-editor"));
      await editor.locator("body").evaluate(() => location.reload());
      const reloaded = await navigation;
      expect(await reloaded.evaluate(() => navigator.onLine)).toBe(false);
      await expect(body).toHaveText("Browser offline edit");
      await expect(body).toBeEditable();
    }
    await context.setOffline(false);
    await page.evaluate(() => {
      const fixture = (window as ReplicaWindow).offlineFixture;
      const [pending] = fixture.client().ledger.getSnapshot().pending;
      fixture.replica().reject(pending.mutationId);
      fixture.replica().editElsewhere(pending.records[0], { body: "Concurrent remote edit" });
      fixture.replica().setOnline(true);
    });
    const recovery = editor.getByRole("status", { name: "Unsaved draft found" });
    await expect(body).toHaveText("Concurrent remote edit");
    await recovery.getByText("Review recovered text").click();
    await expect(recovery.locator("pre")).toHaveText("Browser offline edit");
    await recovery.getByRole("button", { name: "Restore unsaved edits" }).click();
    await editor.getByRole("button", { name: "Keep my edits" }).click();
    await expect.poll(() => page.evaluate(() =>
      (window as ReplicaWindow).offlineFixture.replica().allRecords[0].body)).toBe("Browser offline edit");
  });
}
