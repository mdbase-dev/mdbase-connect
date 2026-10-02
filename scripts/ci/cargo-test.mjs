// cargo test's stable JSON build protocol discovers the exact harness binaries.
// Run each once, then retry only named assertion failures, never build errors,
// crashes, unknown harness output, or doctests. Also drives retry-free stress.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordFailure, reportDir } from "./flake-report.mjs";

export function failures(output) {
  const names = [...output.matchAll(/^test (.+) \.\.\. FAILED\s*$/gm)].map((match) => match[1]);
  const summary = /test result: FAILED\. \d+ passed; (\d+) failed;/.exec(output);
  return summary && Number(summary[1]) === names.length && names.length > 0 ? names : null;
}

async function run(command, args, label, quiet = false, cwd = process.cwd()) {
  mkdirSync(reportDir, { recursive: true });
  let out = "", err = "";
  const child = spawn(command, args, { cwd, env: { ...process.env, CARGO_TERM_COLOR: "never" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data) => { out += data; if (!quiet) process.stdout.write(data); });
  child.stderr.on("data", (data) => { err += data; process.stderr.write(data); });
  const code = await new Promise((done, reject) => { child.on("error", reject); child.on("close", done); });
  writeFileSync(resolve(reportDir, `${process.pid}-${label}.log`), out + err);
  return { code, out };
}

async function main() {
  const args = process.argv.slice(2);
  let iterations = 1, pattern;
  if (args[0] === "--stress") {
    iterations = Number(args.splice(0, 2)[1]);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1000) throw new Error("stress iterations must be 1..1000");
    if (args.shift() !== "--match") throw new Error("stress requires --match REGEX");
    pattern = new RegExp(args.shift());
  }
  const filterIndex = args.indexOf("--filter");
  const filter = filterIndex < 0 ? undefined : args.splice(filterIndex, 2)[1];
  if (filterIndex >= 0 && !filter) throw new Error("--filter requires a test substring");
  // This entry point accepts Cargo selection/feature options, not libtest args.
  if (args.includes("--") || args.includes("--doc") || args.includes("--no-run")) throw new Error("unsupported cargo-test entry point arguments");
  const build = await run("cargo", ["test", ...args, "--no-run", "--message-format=json"], "build", true);
  const messages = build.out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const message of messages) {
    if (message.reason === "compiler-message" && message.message.rendered) process.stderr.write(message.message.rendered);
  }
  if (build.code !== 0) return 1;
  const binaries = [...new Map(messages
    .filter((message) => message.reason === "compiler-artifact" && message.profile.test && message.executable)
    .map((message) => [message.executable, dirname(message.manifest_path)])).entries()];
  if (!binaries.length) throw new Error("Cargo produced no test harnesses");
  let failed = false, selected = 0;
  for (const [index, [binary, cwd]] of binaries.entries()) {
    let tests = filter ? [filter] : [];
    if (pattern) {
      const list = await run(binary, ["--list", "--format=terse"], `list-${index}`, true, cwd);
      const ignored = await run(binary, ["--list", "--ignored", "--format=terse"], `ignored-${index}`, true, cwd);
      if (list.code !== 0 || ignored.code !== 0) return 1;
      const names = (output) => output.split("\n").filter((line) => line.endsWith(": test")).map((line) => line.slice(0, -6));
      const ignoredNames = new Set(names(ignored.out));
      tests = names(list.out).filter((name) => pattern.test(name) && !ignoredNames.has(name));
      selected += tests.length;
      console.log(`${binary}: ${tests.length} stress tests selected`);
      if (!tests.length) continue;
    }
    for (let iteration = 1; iteration <= iterations; iteration++) {
      process.env.CI_FLAKE_ITERATION = String(iteration);
      const result = await run(binary, [...tests, ...(pattern ? ["--exact"] : []), "--color=never"], `test-${index}-${iteration}`, false, cwd);
      if (result.code === 0) continue;
      const names = failures(result.out);
      // A crashed harness may also have earlier assertion failures: never
      // convert that crash into success by rerunning those assertions.
      if (result.code !== 101 || !names) {
        recordFailure({ suite: binary, test: "<harness/infrastructure failure>", recovered: false });
        failed = true;
        continue;
      }
      for (const [retryIndex, name] of names.entries()) {
        let recovered = false;
        if (!pattern && process.env.CI) {
          const retry = await run(binary, [name, "--exact", "--color=never"], `retry-${index}-${retryIndex}`, false, cwd);
          recovered = retry.code === 0 && /test result: ok\. 1 passed; 0 failed;/.test(retry.out);
        }
        recordFailure({ suite: binary, test: name, recovered });
        if (!recovered) failed = true;
      }
    }
  }
  if (pattern && !selected) throw new Error("stress selection matched zero tests");
  // Cargo --no-run does not include doctests. Preserve that original gate;
  // doctest/compiler failures are deliberately not eligible for a retry.
  const hasDoctests = messages.some((message) => message.reason === "compiler-artifact"
    && message.profile.test && message.target.kind.includes("lib") && message.target.doctest);
  if (hasDoctests && !pattern && !args.some((arg) => ["--lib", "--bin", "--bins", "--test", "--tests", "--all-targets", "--bench", "--benches"].includes(arg))) {
    const docs = await run("cargo", ["test", ...args, "--doc", ...(filter ? [filter] : [])], "doctests");
    if (docs.code !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
