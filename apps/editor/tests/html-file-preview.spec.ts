import { expect, test } from "@playwright/test";

test("an HTML attachment scrolls to its own anchor and cached files finish opening", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.locator(".attachment-input").last().setInputFiles([
    {
      name: "anchor.html",
      mimeType: "text/html",
      buffer: Buffer.from('<a href="#section-2" target="_blank">Jump to section</a><div style="height: 2500px"></div><h1 id="section-2">Second section</h1>')
    },
    { name: "other.html", mimeType: "text/html", buffer: Buffer.from("<h1>Other file</h1>") }
  ]);

  const anchorFile = page.getByRole("option", { name: /anchor\.html/ });
  await anchorFile.click();
  const frame = page.getByTitle("HTML preview, anchor.html").contentFrame();
  const target = frame.getByRole("heading", { name: "Second section" });
  await expect(target).not.toBeInViewport();
  const topUrl = page.url();
  await frame.getByRole("link", { name: "Jump to section" }).click();
  await expect(target).toBeInViewport();
  expect(page.url()).toBe(topUrl);

  await page.getByRole("option", { name: /other\.html/ }).click();
  await expect(page.getByTitle("HTML preview, other.html").contentFrame().getByRole("heading")).toHaveText("Other file");
  await anchorFile.click();
  await expect(target).toBeVisible();
  await expect(anchorFile).not.toHaveAttribute("aria-busy");
  await expect(anchorFile).not.toContainText("Opening");
});
