import { expect, test, type Locator } from "@playwright/test";

test.use({ serviceWorkers: "block" });

function renderedPdf(viewer: Locator) {
  return viewer.evaluate(element => [...(element.querySelector("embedpdf-container")?.shadowRoot?.querySelectorAll("img") ?? [])]
    .some(image => image.complete && image.naturalWidth > 0));
}

test("previews small PNGs and recovers when a different image cannot decode", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  const [pixel, swatch] = await page.evaluate(() => [1, 12].map(width => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = width === 1 ? 1 : 6;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#e71335";
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  }));
  await page.locator(".attachment-input").last().setInputFiles([
    { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(pixel, "base64") },
    { name: "swatch.png", mimeType: "image/png", buffer: Buffer.from(swatch, "base64") },
    { name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("no image pixels") }
  ]);
  const workspace = page.locator(".file-workspace");
  for (const [filename, width, height] of [["pixel.png", 1, 1], ["swatch.png", 12, 6]] as const) {
    await page.getByRole("option", { name: new RegExp(filename) }).click();
    const image = workspace.getByRole("img", { name: filename });
    await expect(image).toBeVisible();
    expect(await image.evaluate((img: HTMLImageElement) => ({
      natural: [img.naturalWidth, img.naturalHeight],
      rendered: [img.clientWidth, img.clientHeight]
    }))).toEqual({ natural: [width, height], rendered: [32, 32 * height / width] });
  }
  await page.getByRole("option", { name: /invalid\.png/ }).click();
  await expect(workspace.getByRole("alert")).toHaveText("Couldn’t preview invalid.png");
  await expect(workspace.getByRole("link", { name: "Open original" })).toBeVisible();
  await page.getByRole("option", { name: /pixel\.png/ }).click();
  await expect(workspace.getByRole("img", { name: "pixel.png" })).toBeVisible();
  await expect(workspace.getByRole("alert")).toHaveCount(0);
});

test("reopens a cached PDF after a corrupt PDF reports its error", async ({ page }) => {
  await page.goto("?demo=4");
  await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();
  await page.locator(".attachment-input").last().setInputFiles({
    name: "invalid.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF")
  });
  const valid = page.getByRole("option", { name: /interface-notes\.pdf/ });
  const viewer = page.getByRole("region", { name: "PDF viewer, interface-notes.pdf" });
  await valid.click();
  await expect.poll(() => renderedPdf(viewer)).toBe(true);

  await page.getByRole("option", { name: /invalid\.pdf/ }).click();
  await expect(page.getByText("Error loading document", { exact: true })).toBeVisible();
  await expect(page.locator(".file-workspace").getByRole("link", { name: "Open original" })).toBeVisible();
  await valid.click();
  await expect.poll(() => renderedPdf(viewer)).toBe(true);
  await expect(page.getByText("Error loading document", { exact: true })).toHaveCount(0);
});

test("a failed PDF engine reports a retryable preview error", async ({ page, context }) => {
  await page.clock.install();
  let wasmRequests = 0;
  const pattern = "**/pdfium*.wasm";
  await context.route(pattern, route => {
    wasmRequests += 1;
    return route.abort();
  });
  await page.goto("?demo=4");
  await page.getByRole("option", { name: /interface-notes\.pdf/ }).click();
  const viewer = page.getByRole("region", { name: "PDF viewer, interface-notes.pdf" });
  await expect(viewer.getByRole("status")).toHaveText("Opening interface-notes.pdf");
  await expect.poll(() => wasmRequests).toBeGreaterThan(0);
  await page.clock.fastForward(20_001);
  await expect(viewer.getByRole("alert")).toHaveText("Couldn’t preview interface-notes.pdf");
  await context.unroute(pattern);
  await viewer.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => renderedPdf(viewer)).toBe(true);
});
