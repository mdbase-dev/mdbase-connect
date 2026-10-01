#!/usr/bin/env node
// Synthetic, local-only connector stress. Never uses the installed profile or
// credential store. Build first: cargo build -p mdbase-cli
// Example: MDBASE_CONNECT_STRESS_BINARY=target/release/mdbase node \
//   scripts/stress/connector-lifecycle.mjs --files 50000 --rounds 3 --settle-seconds 1800
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const options = { files: 10000, rounds: 3, concurrency: 32, port: 42201, "soak-seconds": 0, "settle-seconds": 180 };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  const value = Number(process.argv[index + 1]);
  if (!Object.hasOwn(options, key) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected --files/--rounds/--concurrency/--port/--soak-seconds/--settle-seconds <integer>, got ${key}`);
  }
  options[key] = value;
}
assert(options.files > 0 && options.concurrency > 0 && options.concurrency <= 256 && options["settle-seconds"] > 0);
assert(options.port >= 42201 && options.port < 42299, "Reserve two ports in 42201–42299");
if (process.platform !== "linux") throw new Error("This fault/resource harness requires Linux signals, sockets and /proc");
const binary = resolve(process.env.MDBASE_CONNECT_STRESS_BINARY ?? "target/debug/mdbase");
const root = await mkdtemp(join(tmpdir(), "mdbase-connector-stress-"));
const runtimeBinary = join(root, "runtime", "mdbase");
const stateDir = join(root, "state");
const endpoint = join(root, "agent.sock");
const collectionPath = join(root, "collection");
const environment = {
  ...process.env,
  MDBASE_CONNECT_ENV: "test",
  MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file",
  MDBASE_CONNECT_DEV_AUTH: "1",
  RUST_LOG: "warn"
};
for (const key of ["MDBASE_CONNECT_HOME", "MDBASE_CONNECT_SOCKET", "MDBASE_CONNECT_SERVER_URL", "MDBASE_CONNECT_TOKEN", "MDBASE_CONNECT_LOOPBACK_PORT"]) {
  delete environment[key];
}
const run = promisify(execFile);
const children = new Set();
const started = performance.now();
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const report = (phase, values = {}) => console.log(JSON.stringify({ phase, elapsed_ms: Math.round(performance.now() - started), ...values }));
let protocolVersion;
let collectionId;
let daemon;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) {
      child.kill("SIGCONT");
      child.kill("SIGTERM");
    }
  });
}
const assertRunning = () => { if (interrupted) throw new Error("Stress harness interrupted"); };

function launch(socket = endpoint, port = options.port) {
  assertRunning();
  const child = spawn(runtimeBinary, ["--state-dir", stateDir, "--endpoint", socket, "connect", "daemon", "run", "--loopback-port", String(port)], {
    env: environment, stdio: "ignore"
  });
  children.add(child);
  child.exited = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      children.delete(child);
      resolveExit({ code, signal });
    });
  });
  return child;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function request(method, params, timeout = 60000) {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(endpoint);
    const id = randomUUID();
    let bytes = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolveResponse(value);
    };
    socket.setTimeout(timeout, () => finish(new Error(`${method}: control deadline`)));
    socket.on("error", error => finish(error));
    socket.on("close", () => finish(new Error(`${method}: closed without response`)));
    socket.on("connect", () => socket.write(JSON.stringify({ id, protocol_version: protocolVersion, method, ...(params ? { params } : {}) }) + "\n"));
    socket.on("data", chunk => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      try {
        const response = JSON.parse(bytes.slice(0, bytes.indexOf("\n")));
        assert.equal(response.id, id);
        assert.equal(response.protocol_version, protocolVersion);
        if (!response.ok) throw Object.assign(new Error(`${method}: ${response.error?.code ?? "unspecified failure"}`), { code: response.error?.code });
        finish(null, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function poll(action, description, budget = 120000) {
  const deadline = performance.now() + budget;
  let lastError;
  do {
    assertRunning();
    try { if (await action()) return; } catch (error) { lastError = error; }
    await delay(50);
  } while (performance.now() < deadline);
  throw new Error(description, { cause: lastError });
}

async function ready() {
  await poll(async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Daemon exited during startup");
    return (await request("ping", undefined, 1000)).readiness?.ready;
  }, "Daemon did not become ready", 30000);
}

async function stop(child, signal) {
  if (!children.has(child)) return;
  // Also makes cleanup safe if an assertion interrupted the sleep simulation.
  child.kill("SIGCONT");
  child.kill(signal);
  try { await bounded(child.exited, 10000, "Daemon did not stop"); }
  catch (error) { child.kill("SIGKILL"); await child.exited; throw error; }
}

async function parallel(count, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, options.concurrency) }, async () => {
    while (next < count) {
      assertRunning();
      await action(next++);
    }
  }));
}

const pathFor = index => `notes/note-${String(index).padStart(6, "0")}.md`;
const documentFor = (index, generation) => `---\ntitle: Synthetic ${index}\ngeneration: ${generation}\n---\nbody-${index}-${generation}\n`;
const operation = async (name, input) => {
  const value = await request("collections.operation", { collection_id: collectionId, operation: name, input });
  if (value.valid === false) {
    const code = value.diagnostics.find(diagnostic => diagnostic.severity === "error")?.code;
    assert.equal(typeof code, "string", `${name}: invalid outcome has no diagnostic code`);
    throw Object.assign(new Error(`${name}: ${code}`), { code });
  }
  assert.equal(value.valid, true, `${name}: invalid result`);
  return value.result;
};

async function indexed(generation, expected = options.files) {
  let nextProgress = performance.now() + 15000;
  await poll(async () => {
    const value = await operation("query", { where: `generation == ${generation}`, limit: 1 });
    if (performance.now() >= nextProgress) {
      report("index-progress", { generation, indexed: value.meta.total_count, expected });
      nextProgress = performance.now() + 15000;
    }
    return value.meta.total_count === expected;
  }, `Watcher did not converge to generation ${generation} (${expected} files)`, options["settle-seconds"] * 1000);
}

async function sampleResources(phase) {
  const status = await readFile(`/proc/${daemon.pid}/status`, "utf8");
  const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)[1]);
  const threads = Number(status.match(/^Threads:\s+(\d+)/m)[1]);
  const stat = await readFile(`/proc/${daemon.pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const descriptors = (await readdir(`/proc/${daemon.pid}/fd`)).length;
  report(phase, { rss_kib: rss, descriptors, threads, cpu_ticks: cpuTicks });
  return { rss, descriptors };
}

try {
  protocolVersion = JSON.parse((await run(binary, ["--json", "version"], { env: environment })).stdout).local_control_protocol;
  assert(Number.isInteger(protocolVersion));
  await mkdir(join(root, "runtime"));
  await copyFile(binary, runtimeBinary);
  daemon = launch();
  await ready();
  collectionId = (await request("collections.create", { path: collectionPath, name: "Synthetic connector stress", timezone: "UTC" })).id;
  await request("daemon.shutdown");
  await bounded(daemon.exited, 10000, "Graceful shutdown did not settle");
  await mkdir(join(collectionPath, "notes"), { recursive: true });
  await parallel(options.files, index => writeFile(join(collectionPath, pathFor(index)), documentFor(index, 0)));
  daemon = launch();
  await ready();
  await indexed(0);
  report("cold-index", { files: options.files });
  const baseline = await sampleResources("baseline");

  const duplicate = launch(join(root, "duplicate.sock"), options.port + 1);
  const duplicateExit = await bounded(duplicate.exited, 10000, "Duplicate daemon did not reject the profile");
  assert.notEqual(duplicateExit.code, 0);
  assert.equal((await request("ping")).readiness.ready, true);
  report("duplicate-rejected");

  // Rehearse the installer's atomic executable replacement without touching
  // any installed binary. Same-version bits test inode/lifecycle continuity,
  // not a protocol migration (that belongs to the retained-release suites).
  const replacement = join(root, "runtime", "mdbase.next");
  await copyFile(binary, replacement);
  await rename(replacement, runtimeBinary);
  assert.equal((await request("ping")).readiness.ready, true);
  await request("daemon.shutdown");
  await bounded(daemon.exited, 10000, "Pre-upgrade process did not stop");
  daemon = launch();
  await ready();
  await indexed(0);
  report("atomic-runtime-replacement");

  for (let round = 1; round <= options.rounds; round++) {
    // Simulate a bulk checkout while the connector is asleep, then resume it.
    daemon.kill("SIGSTOP");
    await parallel(options.files, index => writeFile(join(collectionPath, pathFor(index)), documentFor(index, round)));
    daemon.kill("SIGCONT");
    await indexed(round);
    await parallel(options.concurrency * 4, async index => {
      const note = index % options.files;
      const read = await operation("read", { path: pathFor(note) });
      assert.equal(read.frontmatter.generation, round);
      assert.equal(read.body.trim(), `body-${note}-${round}`);
      await request("ping");
    });
    report("watcher-storm-and-concurrency", { round, files: options.files, requests: options.concurrency * 8 });
    await sampleResources("before-crash");
    // Do not let the watcher settle this checkout before killing the process.
    // Recovery must discover disk changes even if all observations were lost.
    const crashGeneration = options.rounds + round;
    await parallel(options.files, index => writeFile(join(collectionPath, pathFor(index)), documentFor(index, crashGeneration)));
    await stop(daemon, "SIGKILL");
    daemon = launch();
    await ready();
    await indexed(crashGeneration);
    report("crash-recovered", { round });
  }

  const soakDeadline = performance.now() + options["soak-seconds"] * 1000;
  let turn = 0;
  while (performance.now() < soakDeadline) {
    const count = Math.min(options.files, 100);
    const generation = options.rounds * 2 + ++turn;
    await parallel(count, index => writeFile(join(collectionPath, pathFor(index)), documentFor(index, generation)));
    await indexed(generation, count);
    await parallel(options.concurrency, async index => {
      const note = index % count;
      assert.equal((await operation("read", { path: pathFor(note) })).frontmatter.generation, generation);
    });
    const usage = await sampleResources("soak-turn");
    if (baseline && usage) assert(usage.descriptors <= baseline.descriptors + options.concurrency, "File descriptor growth exceeds the bounded workload");
    await delay(Math.min(5000, Math.max(0, soakDeadline - performance.now())));
  }
  await request("daemon.shutdown");
  await bounded(daemon.exited, 10000, "Final graceful shutdown did not settle");
  report("passed", { files: options.files, rounds: options.rounds, soak_turns: turn });
} finally {
  await Promise.all([...children].map(child => stop(child, "SIGKILL")));
  await rm(root, { recursive: true, force: true });
}
