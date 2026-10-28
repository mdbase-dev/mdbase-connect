// Finite checks for existing locked npm subprojects, through root rpnpm.
// Worker: run build-wasm.sh first. SDK: rcargo build -p mdbn-wasm --lib
// --target wasm32-unknown-unknown --profile wasm-release first (real raw WASM).
import { accessSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const target = process.argv[2];
if (!["hosted-worker", "sdk"].includes(target)) throw new Error("expected hosted-worker or sdk");
const worker = target === "hosted-worker";
const cwd = fileURLToPath(new URL(worker ? "../runtime/deploy/hosted-worker/" : "../runtime/packages/sdk/", import.meta.url));
const scratch = fileURLToPath(new URL(`../runtime/target/mode-package-checks/${target}/`, import.meta.url));
const wasm = fileURLToPath(new URL(worker ? "../runtime/deploy/hosted-worker/hosted.wasm" : "../runtime/target/wasm32-unknown-unknown/wasm-release/mdbn_wasm.wasm", import.meta.url));
accessSync(wasm);
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, ...(!worker ? { MDBN_RUNTIME_WASM: wasm } : {}) };
const tasks = [["ci", "--no-audit", "--no-fund"], ...(worker ? [["run", "types"]] : []), ["run", "typecheck"], ...(!worker ? [["exec", "--", "tsc", "-p", "tsconfig.build.json"]] : []), ["test"]];
for (const args of tasks) {
  const result = spawnSync("npm", args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
