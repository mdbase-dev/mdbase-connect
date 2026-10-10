// Desktop e2e driver: one isolated Obsidian under xvfb (desktop.sh), never the user's.
//   node e2e/run-desktop.mjs [--version 1.13.7] [--kills 5] [--skip fence]
// Writes e2e/results/desktop-linux-<version>.json.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, waitPlugin } from "./cdp.mjs";
import { runAll } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const VERSION = opt("--version", "1.13.7");
const PORT = Number(process.env.PORT ?? 9372);
const VAULT = `rt-${VERSION}`;
const vaultDir = join(here, ".work/vaults", VAULT);
const sh = (...a) => execFileSync(join(here, "desktop.sh"), a, { env: { ...process.env, VERSION, PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] }).toString();

if (existsSync(vaultDir)) rmSync(vaultDir, { recursive: true });
execFileSync("node", [join(here, "plugin/build.mjs")], { stdio: "inherit" });
sh("setup", VAULT, "2");

const platform = {
  async start() {
    sh("start", VAULT);
    const c = await connect({ port: PORT });
    await waitPlugin(c);
    await waitPlugin(c, "mdbase-runtime-e2e-2");
    return c;
  },
  async stop() {
    sh("stop");
  },
  async kill() {
    sh("kill9");
  },
  async outsideWrite(rel, text) {
    mkdirSync(dirname(join(vaultDir, rel)), { recursive: true });
    writeFileSync(join(vaultDir, rel), text);
  },
  async outsideMove(from, to) {
    mkdirSync(dirname(join(vaultDir, to)), { recursive: true });
    renameSync(join(vaultDir, from), join(vaultDir, to));
  },
};

const out = { platform: "linux-desktop", obsidian: VERSION, at: new Date().toISOString(), ...(await runAll(platform, { kills: Number(opt("--kills", 5)), skip: (opt("--skip", "") || "").split(",") })) };
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, `results/desktop-linux-${VERSION}.json`), JSON.stringify(out, null, 1));
