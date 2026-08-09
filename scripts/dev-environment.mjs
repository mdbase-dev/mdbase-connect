#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createConnectEnvironment } from "./lib/connect-environment.mjs";
import { resolveDevelopmentOrigins } from "./lib/development-origins.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const environmentFile = resolve(repoRoot, ".env");
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const command = process.argv[2] ?? "up";
const projectName = process.env.MDBASE_CONNECT_DEV_PROJECT ?? "mdbase-connect-dev";
const bindPort = process.env.MDBASE_CONNECT_BIND_PORT ?? "8787";
const natsPort = process.env.MDBASE_CONNECT_NATS_BIND_PORT ?? "4222";
const origins = resolveDevelopmentOrigins(process.env, bindPort);
const environment = await createConnectEnvironment({
  projectName,
  connectPort: Number(bindPort),
  natsPort: Number(natsPort),
  embeddedHostedProvider: true,
  build: true,
  disposable: false,
  randomizeCredentials: false,
  allowLocalApps: true,
  environment: {
    PUBLIC_URL: origins.publicUrl,
    MDBASE_CONNECT_MANAGEMENT_ORIGINS: origins.managementOrigins.join(","),
    MDBASE_EDITOR_ORIGIN: origins.editorOrigin,
    MDBASE_CONNECT_REGISTRATION: "invite",
    MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET:
      "local-onboarding-rate-limit-secret-0001",
    MDBASE_CONNECT_TERMS_URL: "https://mdbase.dev/terms/",
    MDBASE_CONNECT_PRIVACY_URL: "https://mdbase.dev/privacy/",
    MDBASE_CONNECT_HOSTED_COLLECTIONS: "1"
  }
});

switch (command) {
  case "url":
    console.log(origins.publicUrl);
    break;
  case "up":
    await environment.up();
    console.log(`mdbase connect development environment: ${origins.publicUrl}`);
    break;
  case "down":
    await environment.down();
    break;
  case "reset":
    await environment.reset();
    console.log(`mdbase connect development environment: ${origins.publicUrl}`);
    break;
  case "onboarding": {
    const email = process.argv.slice(3).find((argument) => argument !== "--")
      ?? "onboarding@example.com";
    await environment.reset();
    await environment.compose([
      "exec", "-T", "connect", "node", "services/server/dist/auth-admin-cli.js",
      "policy", "update",
      "--expected-revision", "0",
      "--registration", "invite",
      "--password-auth", "enabled",
      "--email-delivery", "disabled",
      "--terms-version", "dev-1",
      "--privacy-version", "dev-1",
      "--actor", "developer:local",
      "--reason", "Replay starter collection onboarding"
    ], { capture: true });
    const invitation = await environment.compose([
      "exec", "-T", "connect", "node", "services/server/dist/auth-admin-cli.js",
      "invite", "create",
      "--email", email,
      "--entitlement-profile", "beta_v1",
      "--actor", "developer:local",
      "--reason", "Replay starter collection onboarding"
    ], { capture: true });
    console.log(invitation.trim());
    console.log(`Fresh onboarding environment: ${origins.publicUrl}`);
    console.log("Starting the editor. Open the invitation_url above in your browser.");
    const editor = spawn("pnpm", ["--filter", "mdbase-editor", "dev"], {
      cwd: repoRoot,
      env: { ...process.env, MDBASE_CONNECT_URL: origins.publicUrl },
      stdio: "inherit"
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => editor.kill(signal));
    }
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      editor.once("error", rejectExit);
      editor.once("exit", (code) => resolveExit(code));
    });
    if (exitCode !== 0 && exitCode !== null) process.exitCode = exitCode;
    break;
  }
  case "status":
    await environment.status();
    break;
  case "logs":
    await environment.logs();
    break;
  default:
    console.error("Usage: dev-environment.mjs <up|down|reset|onboarding [email]|status|logs|url>");
    process.exitCode = 2;
}
