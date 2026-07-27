import { _electron as electron } from "playwright-core";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const desktopRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");
const executable = resolve(
  repoRoot,
  `target/debug/mdbase-connect${process.platform === "win32" ? ".exe" : ""}`
);
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-progress-"));
const pairingData = join(scratch, "pairing");
const connectedData = join(scratch, "connected");
const { buildApp } = await import("../../../services/server/dist/app.js");
const run = promisify(execFile);
const { createDatabase } = await import("../../../services/server/dist/db.js");
const database = await createDatabase("memory");
const port = await availablePort();
const loopbackPort = await availablePort();
const portalUrl = `http://127.0.0.1:${port}`;
const { app: server } = await buildApp({
  db: database,
  devAuth: true,
  allowInsecureManifests: true,
  publicUrl: portalUrl
});
server.addHook("onRequest", async (request) => {
  if (request.url.startsWith("/v1/connectors/sync")) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_800));
  }
});

let firstApp;
let connectedApp;
try {
  await server.listen({ host: "127.0.0.1", port });
  const session = await fetch(`${portalUrl}/v1/dev/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Connection Test", email: "connection-test@example.com" })
  });
  if (!session.ok) throw new Error(`Could not create test session: HTTP ${session.status}`);
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Test session did not set a cookie");

  firstApp = await launchDesktop(pairingData);
  await firstApp.evaluate(({ app, shell }) => {
    shell.openExternal = async () => "";
    app.relaunch = () => {};
    app.exit = () => {};
  });
  const pairingWindow = await firstApp.firstWindow();
  await pairingWindow.getByRole("heading", { name: "Connect this computer." }).waitFor();
  await pairingWindow.getByLabel("Server").fill(portalUrl);
  await pairingWindow.getByLabel("Computer name").fill("Progress test computer");
  await pairingWindow.getByRole("button", { name: "Continue in browser" }).click();

  const waiting = pairingWindow.getByRole("status").filter({ hasText: "Waiting for browser approval" });
  await waiting.waitFor();
  await assertAnimated(waiting.locator(".status-dot.connecting"));
  const verificationUri = await waiting.locator("code").textContent();
  const pairingId = verificationUri ? new URL(verificationUri).pathname.split("/").at(-1) : null;
  if (!pairingId) throw new Error("Pairing ID was not shown in the desktop application");

  const approval = await fetch(`${portalUrl}/v1/pairing-requests/${pairingId}/approve`, {
    method: "POST",
    headers: { cookie }
  });
  if (!approval.ok) throw new Error(`Could not approve test computer: HTTP ${approval.status}`);
  try {
    await pairingWindow.getByText("Computer approved. Connecting securely…").waitFor({ timeout: 8_000 });
  } catch (error) {
    process.stderr.write(`${await pairingWindow.locator("body").innerText()}\n`);
    throw error;
  }
  await pairingWindow.getByText("mdbase connect is restarting with the new secure connection.").waitFor();
  const storedCloud = JSON.parse(
    await readFile(join(pairingData, "connect-home", "cloud.json"), "utf8")
  );
  if (storedCloud.server_url !== portalUrl) {
    throw new Error("Pairing stored the wrong server origin");
  }
  const storedSecrets = JSON.parse(
    await readFile(join(pairingData, "connect-home", "test-secrets.json"), "utf8")
  );
  const connectorToken = storedSecrets.values.connector;
  if (!connectorToken.startsWith("con_")) throw new Error("Pairing did not store a connector token");
  await firstApp.close();
  firstApp = undefined;

  connectedApp = await launchDesktop(connectedData, connectorToken);
  const connectedWindow = await connectedApp.firstWindow();
  const headerStatus = connectedWindow.locator(".product-header-meta");
  await headerStatus.getByText("Connecting securely…").waitFor({ timeout: 8_000 });
  await assertAnimated(headerStatus.locator(".status-dot.connecting"));
  try {
    await headerStatus.getByText("Connected securely").waitFor({ timeout: 15_000 });
  } catch (error) {
    const currentStatus = await connectedWindow.evaluate(() => window.mdbaseConnect.status());
    process.stderr.write(`${JSON.stringify(currentStatus)}\n${await connectedWindow.locator("body").innerText()}\n`);
    throw error;
  }
  if (await headerStatus.locator(".status-dot.connected").count() !== 1) {
    throw new Error("Connected status did not use the verified connection indicator");
  }
  process.stdout.write("Electron connection progress smoke test passed\n");
} finally {
  for (const userData of [pairingData, connectedData]) {
    await run(executable, [
      "--state-dir",
      join(userData, "connect-home"),
      "daemon",
      "stop"
    ]).catch(() => {});
  }
  await connectedApp?.close().catch(() => {});
  await firstApp?.close().catch(() => {});
  await server.close().catch(() => {});
  await database.end();
  await rm(scratch, { recursive: true, force: true });
}

function launchDesktop(userData, connectorToken) {
  return electron.launch({
    cwd: desktopRoot,
    args: [".", `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      MDBASE_CONNECT_BIN: executable,
      MDBASE_CONNECT_HOME: join(userData, "connect-home"),
      MDBASE_CONNECT_ENV: "test",
      MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file",
      MDBASE_CONNECT_LOOPBACK_PORT: String(loopbackPort),
      ...(connectorToken ? {
        MDBASE_CONNECT_SERVER_URL: portalUrl,
        MDBASE_CONNECT_CONNECTOR_TOKEN: connectorToken
      } : {})
    }
  });
}

async function assertAnimated(locator) {
  await locator.waitFor();
  const animationName = await locator.evaluate((element) => getComputedStyle(element).animationName);
  if (animationName !== "connection-pulse") {
    throw new Error(`Expected a connection progress animation, received ${animationName}`);
  }
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("Could not allocate a test port"));
        return;
      }
      socket.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}
