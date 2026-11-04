import { expect, openScenario, test } from "./review/fixture";
import { authorizationId, pairingId } from "./review/scenarios.mjs";

test("rename survives navigation and reload", async ({ page }) => {
  await openScenario(page, "collection-storage");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Rename Shared research library" }).fill("Coastal research library");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coastal research library", exact: true })).toBeVisible();
});

test("signed-out pairing signs in locally and remembers approval", async ({ page }) => {
  await openScenario(page, "pairing-signed-out");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("maya@chen.example");
  await page.getByLabel("Password", { exact: true }).fill("review-only-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("option", { name: "Field research", exact: true }).click();
  await page.getByRole("button", { name: "Open Reader with Field research", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/v1/pairing-requests/${pairingId}`)).json()).pairing.approved_at).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Access approved", exact: true })).toBeVisible();
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
  await page.getByRole("radio", { name: /Field research/ }).check();
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

test("signup accepts agreements and creates the starter collection", async ({ page }) => {
  await openScenario(page, "signup-agreements");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Maya Chen");
  await page.getByLabel("Password", { exact: true }).fill("a-long-local-review-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("a-long-local-review-password");
  await page.getByRole("checkbox", { name: /I agree to the/ }).check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("My first collection", { exact: true }).first()).toBeVisible();
  await page.reload();
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
