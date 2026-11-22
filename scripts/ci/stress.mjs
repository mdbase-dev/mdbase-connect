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
let passed = true;
const suites = [
  ["packages/client", ["src/base64.test.ts", "src/crypto.test.ts", "src/request-coordinator.test.ts", "src/application-session-startup.test.ts", "src/startup-timing.test.ts", "src/grant-key-leases.test.ts"]],
  ["apps/editor", ["src/CodeEditor.focus.test.tsx", "src/use-session-lifecycle.test.tsx", "src/use-type-definition-lifecycle.test.tsx"]],
  ["services/server", ["src/features/collections/collection-membership-lifecycle.test.ts", "src/features/relay/relay-timeout.test.ts", "src/features/relay/relay-broker.test.ts", "src/features/notifications/notifications.test.ts"]]
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
