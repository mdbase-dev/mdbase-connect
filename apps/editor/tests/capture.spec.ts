import { expect, test } from "@playwright/test";

test("pastes a screenshot through the attachment pipeline and undoes only its reference", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?demo=300");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await body.fill("Before.\n\nAfter.");
  await body.press("Control+Home");
  await body.press("ArrowDown");
  await body.press("ArrowDown");
  await page.evaluate(async () => {
    // A real PNG clipboard item exercises Chromium's clipboard-to-File conversion.
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 80;
    const drawing = canvas.getContext("2d")!;
    drawing.fillStyle = "#28789c";
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  await body.press("Control+v");
  const preview = body.getByRole("img", { name: /^Pasted image .*\.png$/ });
  await expect(preview).toBeVisible();
  await expect(body).toContainText("Before.");
  await expect(body).toContainText("After.");
  // The uploaded collection file is not deleted by undoing the note reference.
  await body.press("Control+z");
  await expect(preview).toHaveCount(0);
  await expect(body).toHaveText("Before.After.");
  await body.press("Control+y");
  // History can restore the source-line caret; leave that line to see its preview.
  await body.press("Control+End");
  await expect(preview).toBeVisible();
  await expect(page.locator(".cm-attachment-upload")).toHaveCount(0);
});

test("drops multiple files at the coordinates rather than the current caret", async ({ page }) => {
  await page.goto("/?demo=300");
  const body = page.getByRole("textbox", { name: "Note body", exact: true });
  await body.fill("Before.\n\nAfter.");
  await body.press("Control+End"); // the drop deliberately targets the start instead
  const data = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["one"], "one.txt", { type: "text/plain" }));
    transfer.items.add(new File(["two"], "two.txt", { type: "text/plain" }));
    return transfer;
  });
  const line = body.locator(".cm-line").first();
  const bounds = await line.boundingBox();
  expect(bounds).not.toBeNull();
  const coordinates = { clientX: bounds!.x + 1, clientY: bounds!.y + bounds!.height / 2 };
  await body.dispatchEvent("dragover", { dataTransfer: data, ...coordinates });
  await expect(page.locator(".cm-editor.is-file-drag-over")).toHaveCount(1);
  await body.dispatchEvent("drop", { dataTransfer: data, ...coordinates });
  await expect(page.locator(".cm-editor.is-file-drag-over")).toHaveCount(0);
  await expect(body.getByRole("link", { name: "one.txt", exact: true })).toBeVisible();
  await expect(body.getByRole("link", { name: "two.txt", exact: true })).toBeVisible();
  await expect(body).toHaveText("one.txttwo.txtBefore.After.");
  await body.press("Control+z");
  await expect(body.getByRole("link", { name: "two.txt", exact: true })).toHaveCount(0);
  await expect(body.getByRole("link", { name: "one.txt", exact: true })).toBeVisible();
  await body.press("Control+z");
  await expect(body).toHaveText("Before.After.");
  await data.dispose();
});
