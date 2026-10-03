import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const iterations = Number(process.argv[2] || 20);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) throw new Error("iterations must be 1..1000");
const root = fileURLToPath(new URL("../../", import.meta.url));
const run = (args, cwd = root, env = process.env) => new Promise((done, reject) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
  child.on("error", reject);
  child.on("close", (code) => done(code === 0));
});
// Keep the harness's parallelism: stress selects full names with libtest's
// union of exact filters, rather than serializing each individual test.
let passed = await run(["scripts/ci/cargo-test.mjs", "--stress", String(iterations), "--match",
  "stress|concurrent|claim_recovery|batch_settlement|durab|lifecycle|recovery|restart|cancellation|replay",
  "--locked", "-p", "mdbase-connect-core", "-p", "mdbase-connect-daemon", "-p", "mdbase-connect-hosted-provider"]);
// unified_cli.rs is cfg(unix). Run its whole lifecycle harness so the watch
// regression competes with daemon/mirror startup as it does in workspace CI.
if (process.platform !== "win32") {
  const ok = await run(["scripts/ci/cargo-test.mjs", "--stress", String(iterations), "--match",
    ".",
    "--locked", "-p", "mdbase-cli", "--test", "unified_cli"]);
  if (!ok) passed = false;
}
const suites = [
  ["packages/client", ["src/base64.test.ts", "src/crypto.test.ts", "src/request-coordinator.test.ts", "src/application-session-startup.test.ts", "src/startup-timing.test.ts", "src/grant-key-leases.test.ts"]],
  ["apps/editor", ["src/CodeEditor.focus.test.tsx", "src/use-session-lifecycle.test.tsx", "src/use-type-definition-lifecycle.test.tsx"]],
  ["packages/sync", ["src/mirror.fault-injection.test.ts", "src/promotion.fault-injection.test.ts", "src/mirror-materializer.test.ts"]],
  ["services/server", ["src/hosted-capability-lifecycle.test.ts", "src/collection-membership-lifecycle.test.ts", "src/relay-timeout.test.ts", "src/relay-broker.test.ts", "src/notifications.test.ts"]]
];
for (let iteration = 1; iteration <= iterations; iteration++) {
  for (const [directory, files] of suites) {
    console.log(`Stress iteration ${iteration}/${iterations}: ${directory}`);
    const ok = await run([resolve(root, "scripts/ci/vitest.mjs"), ...files, "--maxWorkers=2"], resolve(root, directory), {
      ...process.env, CI_FLAKE_STRESS: "1", CI_FLAKE_ITERATION: String(iteration)
    });
    if (!ok) passed = false;
  }
}
process.exitCode = passed ? 0 : 1;
