// Linux isolated Obsidian only. Never reads/writes the user's profile or launches their app.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, waitPlugin } from "../cdp.mjs";
import { ownedTree, verifyStopped } from "./cleanup.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const required = name => { if (!process.env[name]) throw new Error(`required ${name}`); return resolve(process.env[name]); };
const fixtureFile = required("LAB_FIXTURE_FILE");
const statusFile = required("LAB_STATUS_FILE");
const status = JSON.parse(readFileSync(statusFile, "utf8"));
if (status.environment !== "lab" || status.identity !== "verified" || status.connect_origin !== "https://connect-lab.mdbase.dev" || status.daemon?.running !== true) throw new Error("LAB preflight failed");
const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
const parent = realpathSync(join(dirname(fixtureFile), "integration-fixtures"));
const root = realpathSync(fixture.root);
const rel = relative(parent, root);
if (fixture.environment !== "lab" || fixture.labOwnsFixture !== true || !fixture.label?.startsWith("[test]")
  || !rel.startsWith("[test]") || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error("fixture scope failed");
const work = join(here, "../.work");
const app = join(work, "app-1.13.7/obsidian");
if (!existsSync(app)) throw new Error("extract isolated Obsidian1.13.7 into e2e/.work/app-1.13.7 first");
const bundle = process.env.LAB_CLIENT_OUT ? resolve(process.env.LAB_CLIENT_OUT) : join(work, "daemon-client-bundle");
const run = `daemon-client-${Date.now()}-${process.pid}`;
const profile = join(work, run);
const runtime = join(profile, "rt");
const home = join(profile, "home");
const xdg = join(profile, "xdg");
const shim = join(profile, "shim");
for (const path of [runtime, home, xdg, shim, join(home, ".cache"), join(home, ".local/share")]) mkdirSync(path, { recursive: true, mode: 0o700 });
for (const command of ["xdg-mime", "xdg-settings", "xdg-open", "xdg-desktop-menu"]) writeFileSync(join(shim, command), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
const userData = join(xdg, "obsidian");
mkdirSync(userData, { recursive: true });
const registry = JSON.stringify({ vaults: { "lab-test-only": { path: root, open: true, ts: Date.now() } }, updateDisabled: true });
writeFileSync(join(profile, "obsidian.json"), registry);
writeFileSync(join(userData, "obsidian.json"), registry);
const plugin = join(root, ".obsidian/plugins/mdbase-lab-daemon-client");
mkdirSync(plugin, { recursive: true });
for (const name of ["main.js", "manifest.json"]) copyFileSync(join(bundle, name), join(plugin, name));
// Never overwrite another scenario's enabled-plugin configuration.
const communityFile = join(root, ".obsidian/community-plugins.json");
const previousCommunity = existsSync(communityFile) ? readFileSync(communityFile, "utf8") : null;
if (previousCommunity !== null) {
  const enabled = JSON.parse(previousCommunity);
  if (!Array.isArray(enabled) || enabled.some(id => id !== "mdbase-lab-daemon-client")) throw new Error("fixture plugin configuration already owned");
}
writeFileSync(communityFile, '["mdbase-lab-daemon-client"]');
const port = Number(process.env.PORT ?? 9372);
if (port !== 9372) throw new Error("this harness owns only CDP9372");
try {
  await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
  throw new Error("CDP9372 already owned; do not start another instance");
} catch (error) {
  if (error.message?.includes("already owned")) throw error;
}
const proc = spawn("xvfb-run", ["-a", "-s", "-screen 0 1400x900x24", app, "--no-sandbox", `--user-data-dir=${userData}`,
  `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--password-store=basic", "--ozone-platform=x11"], {
  detached: true, stdio: "ignore", env: { PATH: `${shim}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: xdg,
    XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: "disabled:", LANG: "en_US.UTF-8" },
});
let cdp;
let isolatedInstanceStopped = false;
proc.on("error", () => {}); // connect/cleanup report a bounded infrastructure failure
let outcome = { environment: "lab", result: "blocked", stage: "launch", cleanup: "externally-owned-daemon" };
try {
  cdp = await connect({ port });
  await waitPlugin(cdp, "mdbase-lab-daemon-client");
  for (let i = 0; i < 180; i++) {
    const state = await cdp.evaluate('app.plugins.plugins["mdbase-lab-daemon-client"].result');
    if (state?.result !== "running") { outcome = state; break; }
    await new Promise(r => setTimeout(r, 500));
  }
} catch {
  outcome = { ...outcome, result: "blocked", stage: "harness" };
} finally {
  if (cdp) {
    await cdp.evaluate('app.plugins.plugins["mdbase-lab-daemon-client"].onunload()').catch(() => {});
    cdp.close();
  }
  // Capture only our descendants/start times before termination. Never inspect
  // command lines or pgrep/kill a pre-existing Obsidian.
  const owned = await ownedTree(proc.pid);
  try { process.kill(-proc.pid, "SIGTERM"); } catch {}
  await new Promise(r => setTimeout(r, 1000));
  try { process.kill(-proc.pid, "SIGKILL"); } catch {}
  isolatedInstanceStopped = await verifyStopped(owned, port);
  if (previousCommunity !== null) writeFileSync(communityFile, previousCommunity);
}
mkdirSync(join(profile, "evidence"));
writeFileSync(join(profile, "evidence/result.json"), JSON.stringify({ ...outcome, isolatedInstanceStopped }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...outcome, evidence: join(profile, "evidence/result.json"), isolatedInstanceStopped }));
if (outcome.result !== "passed" || !isolatedInstanceStopped) process.exitCode = 1;
