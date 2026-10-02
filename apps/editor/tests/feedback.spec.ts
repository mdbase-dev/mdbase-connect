import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createFeedbackWorker } from "../../../services/feedback/src/index";

// Every feedback request is intercepted: no actual inbox, upload, or Connect account is used.
test("form-first feedback is accessible in light/dark and mobile, and sends only consented data", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/v1/feedback", (route) => {
    if (route.request().method() === "POST") sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("?demo=4");
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback", exact: true });
  await expect(dialog.getByRole("textbox", { name: /What happened/ })).toBeFocused();
  expect(sent).toEqual([]);
  await expect(dialog.locator("details")).toHaveCount(1);
  await expect(dialog.locator("details")).not.toHaveAttribute("open");
  await expect(dialog.getByText("HELP US MAKE IT BETTER")).toHaveCount(0);
  await expect(dialog.locator(".mdbase-feedback-context")).toHaveCount(0);
  await dialog.getByText("What gets sent").click();
  await expect(dialog.getByRole("checkbox", { name: /Include technical diagnostics/ })).not.toBeChecked();
  expect((await new AxeBuilder({ page }).include(".mdbase-feedback-dialog").analyze()).violations).toEqual([]);
  await dialog.getByText("What gets sent").click();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    expect((await new AxeBuilder({ page }).include(".mdbase-feedback-dialog").analyze()).violations).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await dialog.boundingBox(); expect(bounds?.x).toBeGreaterThanOrEqual(0); expect(bounds?.width).toBeLessThanOrEqual(390);
  expect((await new AxeBuilder({ page }).include(".mdbase-feedback-dialog").analyze()).violations).toEqual([]);
  await dialog.getByRole("radio", { name: "Share something you like" }).check();
  await dialog.getByRole("textbox", { name: /What’s working well/ }).fill("I like the calm writing experience.");
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  await expect(dialog.getByText("Thanks for the kind words.")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Thanks for the kind words." })).toBeFocused();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ schema_version: 2, topic: "appreciation", application: { product: "mdbase editor", source_view: "notes" }, message: "I like the calm writing experience." });
  for (const field of ["diagnostics", "screenshot", "context", "reply_email"]) expect(sent[0][field]).toBeUndefined();
});

test("native dialog closes before capture permissions and preserves the draft on cancellation", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => {
      if (document.querySelector<HTMLDialogElement>(".mdbase-feedback-dialog")?.open) throw new Error("Feedback dialog leaked into capture");
      throw new DOMException("Cancelled", "NotAllowedError");
    } });
  });
  await page.goto("?demo=4");
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByRole("textbox", { name: /What happened/ }).fill("Preserve my draft.");
  await dialog.getByRole("button", { name: "Attach screenshot" }).click();
  await expect(dialog.getByText(/No screenshot taken/)).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /What happened/ })).toHaveValue("Preserve my draft.");
  expect(await page.locator(".mdbase-feedback-app").evaluate((element) => (element as HTMLElement).inert)).toBe(false);
});

test("screenshot redaction flattens opaque pixels and sends only the resulting image", async ({ page }) => {
  let sent: { screenshot?: { content_base64: string } } | undefined;
  let email: { attachments: Array<{ filename: string; content: string }> } | undefined;
  const worker = createFeedbackWorker(async (_input, init) => {
    email = JSON.parse(String(init?.body));
    return Response.json({ id: "intercepted-test-email" });
  });
  await page.route("**/v1/feedback", async (route) => {
    const origin = new URL(page.url()).origin;
    sent = route.request().postDataJSON();
    const response = await worker.fetch(new Request("https://feedback.example/v1/feedback", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(sent) }), {
      ALLOWED_ORIGINS: origin, FEEDBACK_FROM: "feedback@example.test", FEEDBACK_TO: "support@example.test", RESEND_API_KEY: "test-secret"
    });
    expect(response.status).toBe(202);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  await page.goto("?demo=4");
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  const original = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 300; canvas.height = 180;
    const context = canvas.getContext("2d")!; context.fillStyle = "#f23a32"; context.fillRect(0, 0, 300, 180);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await dialog.getByLabel("Choose an image").setInputFiles({ name: "private-filename.png", mimeType: "image/png", buffer: Buffer.from(original, "base64") });
  await dialog.getByRole("button", { name: "Mark up screenshot" }).click();
  const markup = page.getByRole("dialog", { name: "Mark up screenshot" });
  await expect(markup.getByRole("button", { name: "Blackout" })).toBeEnabled();
  await markup.getByRole("button", { name: "Blackout" }).click();
  await markup.getByLabel("Screenshot annotation canvas").focus();
  await markup.getByLabel("Screenshot annotation canvas").press("Space");
  await markup.getByLabel("Screenshot annotation canvas").press("Shift+ArrowRight");
  await markup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Include screenshot", exact: true })).not.toBeChecked();
  await expect(dialog.getByText(/Markup discarded/)).toBeVisible();
  await dialog.getByRole("button", { name: "Mark up screenshot" }).click();
  await expect(markup.getByRole("button", { name: "Blackout" })).toBeEnabled();
  await markup.getByRole("button", { name: "Blackout" }).click();
  const canvas = markup.getByLabel("Screenshot annotation canvas");
  await canvas.focus(); await canvas.press("Space"); await canvas.press("Shift+ArrowRight"); await canvas.press("Shift+ArrowDown"); await canvas.press("Space");
  expect((await new AxeBuilder({ page }).include(".mdbase-feedback-markup").analyze()).violations).toEqual([]);
  await markup.getByRole("button", { name: "Apply changes" }).click();
  await expect(markup).not.toBeVisible();
  const image = dialog.getByRole("img", { name: "Screenshot attached to your feedback" });
  const pixel = await image.evaluate(async (element) => {
    const image = element as HTMLImageElement; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(175, 115, 1, 1).data);
  });
  expect(pixel).toEqual([0, 0, 0, 255]);
  const flattened = (await image.getAttribute("src"))!.split(",")[1]; expect(flattened).not.toBe(original);
  await dialog.getByRole("textbox", { name: /What happened/ }).fill("Here is the problem, with private details removed.");
  await dialog.getByRole("button", { name: "Send feedback", exact: true }).click();
  await expect(dialog.getByText("Thanks for the report.")).toBeVisible();
  expect(sent?.screenshot).toEqual({ media_type: "image/png", filename: "screenshot.png", content_base64: flattened });
  expect(email?.attachments).toEqual([{ filename: "screenshot.png", content: flattened }]);
});

test("feedback keeps application shortcuts out and restores the draft/focus after Escape", async ({ page }) => {
  await page.goto("?demo=4");
  const entry = page.getByRole("button", { name: "Send feedback", exact: true });
  await entry.click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByRole("textbox", { name: /What happened/ }).fill("Keep the editor unchanged while I report this.");
  await dialog.getByRole("textbox", { name: /What happened/ }).press("Control+Shift+N");
  await expect(page.locator(".new-note-composer")).toHaveCount(0);
  await dialog.getByRole("textbox", { name: /What happened/ }).press("Escape");
  await expect(dialog).not.toBeVisible(); await expect(entry).toBeFocused();
  await entry.click();
  await expect(dialog.getByRole("textbox", { name: /What happened/ })).toHaveValue("Keep the editor unchanged while I report this.");
});

test("bug animation is finite and respects reduced motion", async ({ page }) => {
  await page.goto("?demo=4");
  const bug = page.locator(".mdbase-feedback-trigger .mdbase-feedback-bug");
  await expect(bug).toBeVisible(); await bug.evaluate((element) => element.classList.add("is-wiggling"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await bug.evaluate((element) => getComputedStyle(element).animationIterationCount)).toBe("2");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await bug.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
});
