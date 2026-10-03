import { _electron as electron } from "playwright-core";
import { resolve } from "node:path";

const portalUrl = process.env.MDBASE_CONNECT_PORTAL_URL;
if (!portalUrl) throw new Error("MDBASE_CONNECT_PORTAL_URL is required");
const shell = resolve(import.meta.dirname, "portal-shell.cjs");
const pairingResponse = await fetch(`${portalUrl}/v1/pairing-requests`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ connector_name: "Test computer" })
});
if (!pairingResponse.ok) throw new Error(`Could not start pairing: HTTP ${pairingResponse.status}`);
const pairing = await pairingResponse.json();
const pairingUrl = new URL(`/pair/${pairing.pairing_id}`, portalUrl).href;
const electronApp = await electron.launch({
  args: [shell],
  // The portal owns transactions; its root now redirects to the editor.
  env: { ...process.env, MDBASE_CONNECT_PORTAL_URL: pairingUrl }
});

try {
  const page = await electronApp.firstWindow();
  await page.getByRole("heading", { name: /^(Open your account|Test computer)$/ }).waitFor();
  const loginHeading = page.getByRole("heading", { name: "Open your account" });
  if (await loginHeading.isVisible()) {
    await page.getByLabel("Name").fill("Portal Test");
    await page.getByLabel("Email").fill("portal-test@example.com");
    await page.getByRole("button", { name: "Continue" }).click();
  }
  await page.getByRole("heading", { name: "Test computer" }).waitFor();
  await page.getByRole("button", { name: "Approve computer" }).click();
  await page.getByRole("heading", { name: "Return to mdbase connect." }).waitFor();
  const screenshot = process.env.MDBASE_CONNECT_PORTAL_SCREENSHOT;
  if (screenshot) {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.screenshot({ path: screenshot, animations: "disabled" });
  }
  process.stdout.write("Portal smoke test passed\n");
} finally {
  await electronApp.close();
}
