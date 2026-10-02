// Opt-in regression: run against a local demo/fixture with feedback configured.
// xvfb-run -a -s '-screen 0 1800x1400x24' node tests/feedback-capture.mjs
// FEEDBACK_CAPTURE_URL defaults to the isolated Vite demo below. No reports are submitted.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const env = { ...process.env }; delete env.WAYLAND_DISPLAY; env.XDG_SESSION_TYPE = "x11";
const positiveControl = process.env.CAPTURE_POSITIVE_CONTROL === "1";
const browser = await chromium.launch({ headless: false, env, args: ["--ozone-platform=x11", "--auto-accept-this-tab-capture", "--enable-usermedia-screen-capturing", "--allow-http-screen-capture", "--auto-select-tab-capture-source-by-title=mdbase feedback capture regression", "--disable-features=WebRtcHideLocalIpsWithMdns"] });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const posts = [];
  await page.route("**/v1/feedback", (route) => { posts.push(route.request().method()); return route.abort(); });
  await page.goto(process.env.FEEDBACK_CAPTURE_URL ?? "http://127.0.0.1:8877/?demo=4");
  await page.evaluate(() => { document.title = "mdbase feedback capture regression"; });
  await page.getByRole("button", { name: "Send feedback", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send feedback" });
  await dialog.getByRole("textbox", { name: /What happened/ }).fill("This capture must preserve the draft but not its pixels.");
  await page.evaluate((positiveControl) => {
    const element = document.querySelector(".mdbase-feedback-dialog");
    const canary = document.createElement("div");
    canary.style.cssText = "position:absolute;top:0;left:0;width:200px;height:200px;background:rgb(255,0,255);z-index:9999;pointer-events:none";
    element.append(canary);
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    window.__feedbackTracks = [];
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      window.__feedbackDialogOpenAtCapture = document.querySelector(".mdbase-feedback-dialog").open;
      const stream = await original(options); window.__feedbackTracks.push(...stream.getTracks()); return stream;
    };
    if (positiveControl) HTMLDialogElement.prototype.close = function () {};
  }, positiveControl);
  await dialog.getByRole("button", { name: "Attach screenshot" }).click();
  const preview = dialog.getByRole("img", { name: "Screenshot attached to your feedback" });
  await preview.waitFor({ timeout: 25_000 });
  const result = await preview.evaluate(async (element) => {
    await element.decode();
    const canvas = document.createElement("canvas"); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(element, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let leakedPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 200 && pixels[i + 1] < 100 && pixels[i + 2] > 200) leakedPixels++;
    return { leakedPixels, dialogOpenAtCapture: window.__feedbackDialogOpenAtCapture, width: canvas.width, height: canvas.height, tracks: window.__feedbackTracks.map((track) => track.readyState), inert: document.querySelector(".mdbase-feedback-app").inert };
  });
  console.log(JSON.stringify({ positiveControl, ...result }));
  if (positiveControl) assert.ok(result.leakedPixels > 1000, "Positive control must detect native-dialog pixels in capture");
  else assert.equal(result.leakedPixels, 0, "Feedback form/backdrop must not leak into screenshots");
  assert.equal(result.dialogOpenAtCapture, positiveControl);
  assert.ok(result.tracks.length > 0); assert.ok(result.tracks.every((state) => state === "ended"));
  assert.equal(result.inert, false); assert.ok(result.width <= 1600 && result.height <= 1200);
  assert.equal(await dialog.getByRole("textbox", { name: /What happened/ }).inputValue(), "This capture must preserve the draft but not its pixels.");
  assert.deepEqual(posts, [], "Capture must not submit or upload feedback");
} finally { await browser.close(); }
