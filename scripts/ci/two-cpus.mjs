// Linux/Windows: inherited two-CPU affinity. macOS has no affinity API:
// cpulimit caps the process tree at 200% (two CPUs' aggregate time), not
// physical-core pinning. Keep the distinction explicit in the run summary.
import { readFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

let command, args, description;
const forwarded = process.argv.slice(2);
if (!forwarded.length) throw new Error("usage: node two-cpus.mjs SCRIPT [ARGS]");
if (process.platform === "linux") {
  const allowed = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync("/proc/self/status", "utf8"))[1];
  const cpus = allowed.split(",").flatMap((part) => {
    const [start, end = start] = part.split("-").map(Number);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }).slice(0, 2);
  if (cpus.length !== 2) throw new Error("two CPUs are required");
  command = "taskset";
  args = ["--cpu-list", cpus.join(","), process.execPath, ...forwarded];
  description = `Linux affinity: CPUs ${cpus.join(",")}`;
} else if (process.platform === "win32") {
  command = "pwsh";
  args = ["-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; [System.Diagnostics.Process]::GetCurrentProcess().ProcessorAffinity = 3; $argv = @(ConvertFrom-Json $env:CI_FLAKE_ARGV); & $env:CI_FLAKE_NODE @argv; exit $LASTEXITCODE"];
  description = "Windows inherited affinity: CPUs 0,1";
} else if (process.platform === "darwin") {
  command = "cpulimit";
  args = ["--include-children", "--limit=200", "--", process.execPath, ...forwarded];
  description = "macOS process-tree CPU budget: 200% (not physical affinity)";
} else throw new Error(`unsupported stress platform: ${process.platform}`);
console.log(description);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${description}\n`);
const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, CI_FLAKE_ARGV: JSON.stringify(forwarded), CI_FLAKE_NODE: process.execPath } });
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("close", (code) => { process.exitCode = code ?? 1; });
