import { expect, openScenario, test } from "./review/fixture";

test("interaction budgets at 60ms API latency", async ({ page }) => {
  await openScenario(page, "collection-storage");
  const measure = async (name: string, action: () => Promise<void>, visible: () => Promise<void>, budget: number) => {
    const start = performance.now();
    await action();
    await visible();
    const elapsed = Math.round(performance.now() - start);
    console.log(`${name}: ${elapsed}ms (budget ${budget}ms; fake API latency 60ms)`);
    expect(elapsed, name).toBeLessThan(budget);
  };
  await measure("sidebar navigation", () => page.getByRole("link", { name: "Computers", exact: true }).click(),
    () => expect(page.getByRole("heading", { name: "Computers", exact: true })).toBeVisible(), 1500);
  await page.getByRole("link", { name: "Collections", exact: true }).click();
  await page.getByRole("link", { name: "Shared research library", exact: true }).click();
  await page.getByRole("link", { name: "Storage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
  await measure("command palette", () => page.getByRole("button", { name: /^Search/ }).click(),
    () => expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible(), 1000);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Actions for Shared research library" }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Rename Shared research library" }).fill("Coastal research library");
  await measure("rename", () => page.getByRole("button", { name: "Save", exact: true }).click(),
    () => expect(page.getByText("Coastal research library", { exact: true }).filter({ visible: true }).first()).toBeVisible(), 2500);
  await expect(page.getByText("Coastal research library", { exact: true }).first()).toBeVisible();
});
