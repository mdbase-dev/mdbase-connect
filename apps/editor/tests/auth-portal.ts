import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as base, type Page } from "@playwright/test";

export const authentication = {
  provider: "session",
  providers: [
    { id: "google", label: "Continue with Google", login_url: "/auth/google" },
    { id: "github", label: "Continue with GitHub", login_url: "/auth/github" }
  ],
  registration: "open",
  password_login: true,
  password_recovery: true,
  password_public_registration: true,
  external_public_registration: true,
  agreements: {
    terms: { version: "1", url: "https://mdbase.dev/terms/" },
    privacy: { version: "1", url: "https://mdbase.dev/privacy/" }
  }
};

export const googleFixture = `window.google = { accounts: { id: {
  initialize(config) { window.googleFixtureConfig = config; },
  renderButton(element, config) {
    element.dataset.theme = config.theme;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'mdbase-button provider-button';
    button.style.width = config.width + 'px';
    button.textContent = 'Continue with Google';
    button.onclick = () => window.googleFixtureConfig.callback({credential:'fixture-credential'});
    element.append(button);
  }
} } };`;

// Shared by auth acceptance and visual tests. Each parallel slot has its own
// portal; retries reuse that slot, rather than racing for a hard-coded port.
export const test = base.extend<{}, { authPortal: string }>({
  authPortal: [async ({}, use, workerInfo) => {
    const port = Number(process.env.MDBASE_EDITOR_E2E_PORT ?? 42_873) + 1 + workerInfo.parallelIndex;
    const origin = `http://127.0.0.1:${port}`;
    const portal = spawn(process.execPath, [
      fileURLToPath(new URL("../../portal/node_modules/vite/bin/vite.js", import.meta.url)),
      "--host", "127.0.0.1", "--port", String(port), "--strictPort"
    ], { cwd: fileURLToPath(new URL("../../portal", import.meta.url)), stdio: "ignore" });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (portal.exitCode !== null) throw new Error("Local auth portal exited before becoming ready.");
        try { ready = (await fetch(origin)).ok; } catch { /* wait for Vite */ }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error("Local auth portal did not become ready.");
      await use(origin);
    } finally {
      if (portal.exitCode === null) {
        const stopped = new Promise((resolve) => portal.once("exit", resolve));
        portal.kill("SIGTERM");
        await stopped;
      }
    }
  }, { scope: "worker" }]
});

export async function installAuthRoutes(page: Page, origin: string) {
  await page.route(`${origin}/v1/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: path === "/v1/me" ? 401 : 200, json: path === "/v1/auth/config" ? authentication : {} });
  });
  await page.route(`${origin}/auth/google?**`, (route) => route.fulfill({
    json: { client_id: "fixture-client", nonce: "fixture-nonce" }
  }));
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({
    contentType: "application/javascript", body: googleFixture
  }));
}
