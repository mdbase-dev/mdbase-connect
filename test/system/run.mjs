#!/usr/bin/env node

import { spawn } from "node:child_process";
import { systemSuites, preparationSteps } from "./suites.mjs";

const requested = [];
let prepare = true;
let list = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--suite") {
    const value = process.argv[index + 1];
    if (!value) usage("--suite requires a name");
    requested.push(...value.split(",").filter(Boolean));
    index += 1;
  } else if (argument === "--no-prepare") {
    prepare = false;
  } else if (argument === "--list") {
    list = true;
  } else if (argument === "--help" || argument === "-h") {
    usage();
  } else {
    usage(`Unknown option: ${argument}`);
  }
}

if (list) {
  for (const [name, suite] of Object.entries(systemSuites)) {
    process.stdout.write(`${name.padEnd(20)} ${suite.description}\n`);
  }
  process.exit(0);
}

const names = requested.length === 0 || requested.includes("all")
  ? Object.keys(systemSuites)
  : [...new Set(requested)];
for (const name of names) {
  if (!systemSuites[name]) usage(`Unknown system suite: ${name}`);
}

if (prepare) {
  const preparation = new Set(
    names.flatMap((name) => systemSuites[name].prepare)
  );
  for (const name of preparation) {
    await execute(preparationSteps[name], `prepare:${name}`);
  }
}

for (const name of names) {
  const suite = systemSuites[name];
  let command = suite.command;
  if (
    suite.headless
    && process.platform === "linux"
    && !process.env.DISPLAY
  ) {
    command = ["xvfb-run", "-a", ...command];
  }
  await execute(command, name);
}

function usage(error) {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stderr.write(
    "Usage: test/system/run.mjs [--suite NAME[,NAME...]] [--no-prepare] [--list]\n"
  );
  process.exit(error ? 2 : 0);
}

function execute([command, ...arguments_], label) {
  process.stdout.write(`\n== ${label}: ${command} ${arguments_.join(" ")}\n`);
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, {
      cwd: new URL("../..", import.meta.url),
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(
        `${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`
      ));
    });
  });
}
