#!/usr/bin/env node

import { spawn } from "node:child_process";
import { useRcargo } from "../../scripts/lib/rcargo.mjs";

const environment = {
  MDBASE_CONNECT_ENV: "test",
  MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file"
};
// rcargo does not forward the environment; Cargo configuration reaches the VM.
const remote = useRcargo();
const configuration = remote
  ? Object.entries(environment).flatMap(([name, value]) => ["--config", `env.${name}="${value}"`])
  : [];
const child = spawn(remote ? "rcargo" : "cargo", ["test", ...configuration, "--workspace", ...process.argv.slice(2)], {
  env: { ...process.env, ...environment },
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
