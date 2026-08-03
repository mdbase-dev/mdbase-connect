#!/usr/bin/env node

import { spawn } from "node:child_process";

const child = spawn("cargo", ["test", "--workspace", ...process.argv.slice(2)], {
  env: {
    ...process.env,
    MDBASE_CONNECT_ENV: "test",
    MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file"
  },
  stdio: "inherit"
});

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
