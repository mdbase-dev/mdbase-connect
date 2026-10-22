import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const suites = {
  tasknotes: { app: ".", repository: "callumalpass/tasknotes-app" },
  writer: { app: "apps/writer", repository: "mdbase-dev/mdbase-writer" },
  reader: { app: "apps/reader", repository: "mdbase-dev/mdbase-reader" },
};
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// Replace, rather than layer on top of, consumer SDK pins and emergency patches.
export function overrideConfig(config, tarballs) {
  for (const section of sections) {
    for (const name of Object.keys(config[section] ?? {})) {
      if (!name.startsWith("@mdbase-dev/")) continue;
      assert(tarballs[name], `No candidate tarball for ${name}`);
      config[section][name] = tarballs[name];
    }
  }
  for (const field of ["overrides", "patchedDependencies"]) {
    for (const selector of Object.keys(config[field] ?? {})) {
      if (selector.includes("@mdbase-dev/")) delete config[field][selector];
    }
  }
  return config;
}

export async function inspectTarballs(directory) {
  const packages = {};
  const hashes = {};
  let version;
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".tgz")).sort()) {
    const path = resolve(directory, file);
    const manifest = JSON.parse(command("tar", ["-xOf", path, "package/package.json"]));
    assert(manifest.name?.startsWith("@mdbase-dev/"), `Unexpected tarball ${file}`);
    assert(!packages[manifest.name], `Duplicate candidate ${manifest.name}`);
    version ??= manifest.version;
    assert.equal(manifest.version, version, "Candidate package versions differ");
    packages[manifest.name] = `file:${path}`;
    hashes[manifest.name] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  assert(packages["@mdbase-dev/connect"], "Candidate connect tarball is missing");
  // Internal edges must also use this candidate, never silently resolve from npm.
  for (const path of Object.values(packages)) {
    const manifest = JSON.parse(command("tar", ["-xOf", path.slice(5), "package/package.json"]));
    for (const section of sections) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (name.startsWith("@mdbase-dev/")) assert(packages[name], `Candidate edge ${name} is missing`);
      }
    }
  }
  return { packages, hashes, version };
}

export function verifyInstalledPackages(lock, checkout, packages) {
  const installed = new Set();
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("@mdbase-dev/")) continue;
    const name = key.slice(0, key.indexOf("@", 1));
    const tarball = value.resolution?.tarball;
    assert(tarball?.startsWith("file:") && packages[name], `Registry or non-candidate SDK resolution: ${key}`);
    assert.equal(resolve(checkout, tarball.slice(5)), packages[name].slice(5), `Non-candidate SDK resolution: ${key}`);
    assert(!key.includes("patch_hash"), `Patched candidate: ${key}`);
    installed.add(name);
  }
  assert(installed.has("@mdbase-dev/connect"), "Candidate connect was not installed");
  for (const key of Object.keys(lock.patchedDependencies ?? {})) {
    assert(!key.startsWith("@mdbase-dev/"), `SDK patch remains: ${key}`);
  }
}

export async function runCanary(consumer, checkout, directory, extraArguments = []) {
  const suite = suites[consumer];
  assert(suite, `Unknown consumer ${consumer}`);
  checkout = resolve(checkout);
  const app = resolve(checkout, suite.app);
  // This command edits manifests and lockfiles: require a disposable, clean checkout.
  assert.equal(command("git", ["status", "--porcelain"], checkout).trim(), "", "Use a clean disposable consumer checkout");
  const revision = command("git", ["rev-parse", "HEAD"], checkout).trim();
  const candidate = await inspectTarballs(resolve(directory));
  const env = { ...process.env, CI: "1" };
  const pnpm = (args, cwd = checkout, environment = env) => run("pnpm", args, cwd, environment);
  const workspace = resolve(checkout, "pnpm-workspace.yaml");
  let workspaceText;
  try { workspaceText = await readFile(workspace, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Fence standalone checkouts from any ancestor workspace, including in
  // pnpm subcommands launched by the consumer's own build/preview scripts.
  if (workspaceText === undefined) {
    workspaceText = "packages:\n  - '.'\n";
    await writeFile(workspace, workspaceText);
  }

  // Bootstrap the consumer's locked tools (including its YAML parser).
  await pnpm(["install", "--frozen-lockfile"]);
  const yaml = createRequire(resolve(app, "package.json"))("yaml");
  const files = command("git", ["ls-files", "-z", "package.json", "**/package.json"], checkout).split("\0").filter(Boolean);
  for (const file of files) {
    const path = resolve(checkout, file);
    const manifest = overrideConfig(JSON.parse(await readFile(path, "utf8")), candidate.packages);
    if (manifest.pnpm) overrideConfig(manifest.pnpm, candidate.packages);
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const config = overrideConfig(yaml.parse(workspaceText), candidate.packages);
  config.overrides = { ...config.overrides, ...candidate.packages };
  await writeFile(workspace, yaml.stringify(config));
  await pnpm(["install", "--no-frozen-lockfile"]);
  const lock = yaml.parse(await readFile(resolve(checkout, "pnpm-lock.yaml"), "utf8"));
  verifyInstalledPackages(lock, checkout, candidate.packages);
  await pnpm(["exec", "playwright", "install", "chromium"], app);
  // Writer's reliability suite currently hardcodes a workstation browser path.
  const playwright = createRequire(resolve(app, "package.json"))(consumer === "writer" ? "playwright" : "@playwright/test");
  env.CHROME = playwright.chromium.executablePath();

  const port = Number(process.env.CANARY_PORT ?? { tasknotes: 4173, writer: 5320, reader: 5193 }[consumer]);
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, "Invalid CANARY_PORT");
  const origin = `http://127.0.0.1:${port}`;
  if (consumer === "tasknotes") {
    Object.assign(env, {
      VITE_BASE_PATH: "/tasknotes-app/",
      TASKNOTES_APP_URL: `${origin}/tasknotes-app`,
      TASKNOTES_WEB_ONLY: "1",
      PLAYWRIGHT_BASE_URL: `${origin}/tasknotes-app/`,
      PLAYWRIGHT_WEB_SERVER_COMMAND: `pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
    });
    // The relay browser assertion is timing-sensitive. The consumer's retained
    // #557 regression forces supersession and must not be masked by its retry UI.
    await pnpm(["exec", "vitest", "run", "src/cloud/startup-reconciliation.test.ts"]);
    await pnpm(["build:e2e"]);
    // This is production-smoke.yml's desktop integration lane, including encrypted relay startup.
    // Its live production HTTP checks do not exercise the candidate SDK and are deliberately not run.
    await pnpm(["test:e2e", "--project=desktop", ...extraArguments]);
  } else {
    assert.equal(extraArguments.length, 0, "Extra test arguments are only supported for TaskNotes");
    env.BASE = `${origin}/`;
    env.READER_AUDIT_ORIGIN = origin;
    if (consumer === "reader") {
      // Reader writes audit screenshots/reports under tmpdir(); retain them in
      // the same out/ artifact location as Writer, including on suite failure.
      env.TMPDIR = resolve(app, "out");
      await mkdir(env.TMPDIR, { recursive: true });
    }
    // Both audits require Vite source/fixture routes; a production preview is insufficient.
    await withServer(["dev", "--port", String(port), "--strictPort"], app, env, origin,
      () => pnpm(["test:browser"], app));
  }
  return { schema_version: 1, consumer, repository: suite.repository, revision, version: candidate.version, tarballs_sha256: candidate.hashes };
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")} failed`);
  return result.stdout;
}

async function run(executable, args, cwd, env) {
  console.log(`+ ${executable} ${args.join(" ")} (${cwd})`);
  const child = spawn(executable, args, { cwd, env, stdio: "inherit" });
  await new Promise((res, rej) => {
    child.on("error", rej);
    child.on("exit", (code, signal) => code === 0 ? res() : rej(new Error(`${executable} exited ${code ?? signal}`)));
  });
}

async function withServer(args, cwd, env, origin, body) {
  // Never mistake another local process for the consumer server we own.
  await new Promise((res, rej) => {
    const probe = createServer();
    probe.once("error", rej);
    probe.listen(Number(new URL(origin).port), "127.0.0.1", () => probe.close(res));
  });
  const child = spawn("pnpm", args, { cwd, env, stdio: "inherit", detached: true });
  let failed;
  child.on("error", (error) => { failed = error; });
  child.on("exit", (code) => { failed = new Error(`Consumer dev server exited ${code}`); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failed) throw failed;
      try { ready = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { /* Not listening yet; the bounded readiness loop owns startup. */ }
      if (ready) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    assert(ready, `Consumer server did not become ready at ${origin}`);
    await body();
    if (failed) throw failed;
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [consumer, checkout, directory, ...args] = process.argv.slice(2);
  assert(consumer && checkout && directory,
    "Usage: node scripts/ci/consumer-canary.mjs tasknotes|writer|reader DISPOSABLE_CHECKOUT TARBALL_DIRECTORY [TaskNotes test arguments]");
  const result = await runCanary(consumer, checkout, directory, args);
  console.log(JSON.stringify(result, null, 2));
  if (process.env.CANARY_REPORT) await writeFile(process.env.CANARY_REPORT, `${JSON.stringify(result, null, 2)}\n`);
}
