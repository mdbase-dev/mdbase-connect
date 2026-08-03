#!/usr/bin/env node

import { existsSync } from "node:fs";
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
  build: true,
  disposable: false,
  randomizeCredentials: false,
  environment: {
    PUBLIC_URL: origins.publicUrl,
    MDBASE_CONNECT_MANAGEMENT_ORIGINS: origins.managementOrigins.join(","),
    MDBASE_EDITOR_ORIGIN: origins.editorOrigin
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
  case "status":
    await environment.status();
    break;
  case "logs":
    await environment.logs();
    break;
  default:
    console.error("Usage: dev-environment.mjs <up|down|reset|status|logs|url>");
    process.exitCode = 2;
}
