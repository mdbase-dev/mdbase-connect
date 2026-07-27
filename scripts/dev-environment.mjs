#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const command = process.argv[2] ?? "up";
const projectName = process.env.MDBASE_CONNECT_DEV_PROJECT ?? "mdbase-connect-dev";
const bindPort = process.env.MDBASE_CONNECT_BIND_PORT ?? "8787";
const compose = [
  "compose",
  "--file",
  resolve(repoRoot, "docker-compose.yml"),
  "--project-name",
  projectName
];

const commands = {
  up: ["up", "--detach", "--build", "--wait", "--wait-timeout", "180"],
  down: ["down", "--remove-orphans", "--timeout", "5"],
  reset: ["down", "--volumes", "--remove-orphans", "--timeout", "5"],
  status: ["ps"],
  logs: ["logs", "--follow", "--no-color"]
};

if (command === "url") {
  console.log(`http://127.0.0.1:${bindPort}`);
} else if (!(command in commands)) {
  console.error("Usage: dev-environment.mjs <up|down|reset|status|logs|url>");
  process.exitCode = 2;
} else {
  await runDocker(commands[command]);
  if (command === "reset") await runDocker(commands.up);
  if (command === "up" || command === "reset") {
    console.log(`mdbase connect development environment: http://127.0.0.1:${bindPort}`);
  }
}

function runDocker(arguments_) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("docker", [...compose, ...arguments_], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PUBLIC_URL:
          process.env.PUBLIC_URL ?? `http://127.0.0.1:${bindPort}`,
        MDBASE_CONNECT_BIND_PORT: bindPort
      },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(
        `Docker Compose failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`
      ));
    });
  });
}
