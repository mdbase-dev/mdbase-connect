// Use Vitest's per-test retry lifecycle (including hooks), not a whole-suite retry.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { reportDir } from "./flake-report.mjs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(resolve("package.json"));
const stress = process.env.CI_FLAKE_STRESS === "1";
const forwarded = process.argv.slice(2);
if (forwarded[0] === "--") forwarded.shift();
const args = [resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs"), "run", ...forwarded];
if (process.env.CI || stress) args.push(
  "--retry", stress ? "0" : "1", "--reporter=default",
  `--reporter=${fileURLToPath(new URL("./vitest-reporter.mjs", import.meta.url))}`
);
const recording = Boolean(process.env.CI || stress);
if (recording) mkdirSync(reportDir, { recursive: true });
const child = spawn(process.execPath, args, { stdio: recording ? ["ignore", "pipe", "pipe"] : "inherit" });
if (recording) {
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", (data) => {
      output.write(data);
      appendFileSync(resolve(reportDir, `vitest-${process.pid}.log`), data);
    });
  }
}
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", (code) => { process.exitCode = code ?? 1; });
