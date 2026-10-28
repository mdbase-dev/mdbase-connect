// Run this finite npm subproject check through the root rpnpm dispatcher.
// Build hosted.wasm with its existing remote-only build-wasm.sh first.
import { accessSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../runtime/deploy/hosted-worker/", import.meta.url));
const scratch = fileURLToPath(new URL("../runtime/target/mode-worker-checks/", import.meta.url));
accessSync(new URL("../runtime/deploy/hosted-worker/hosted.wasm", import.meta.url));
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
for (const args of [["ci", "--no-audit", "--no-fund"], ["run", "types"], ["run", "typecheck"], ["test"]]) {
  const result = spawnSync("npm", args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
