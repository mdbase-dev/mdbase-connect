import { expect, test } from "@playwright/test";
import { replaceOpeningNoteBody } from "./note-body";

test("version history shows an earlier version against the note now and restores it", async ({ page }) => {
  await page.goto("?demo=4");
  const body = page.getByRole("textbox", { name: "Note body" });
  const editor = page.getByRole("main", { name: "Note editor" });
  await replaceOpeningNoteBody(body, "A deliberately quiet editing surface.");
  await expect(editor).toHaveAttribute("data-save-state", "saved");

  await page.getByRole("button", { name: "Version history", exact: true }).click();
  const history = page.getByRole("complementary", { name: "Version history" });
  await history.getByRole("button", { name: /Created/ }).click();
  const diff = history.getByRole("table", { name: "Differences from the note now" });
  await expect(diff).toContainText("Good tools leave room around the work.");
  await expect(diff).toContainText("A deliberately quiet editing surface.");

  await history.getByRole("button", { name: "Restore this version" }).click();
  const confirm = page.getByRole("dialog", { name: "Restore this version?" });
  await confirm.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(body).toContainText("Good tools leave room around the work.");
  await expect(editor).toHaveAttribute("data-save-state", "saved");

  // The restore is one more save; the text it replaced stays in history.
  await expect(history.getByRole("button", { name: /saves/ })).toBeVisible();
  await expect(history.getByRole("button", { name: /Created/ })).toBeVisible();
});
