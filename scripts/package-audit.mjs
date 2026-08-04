import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { publicPackages } from "./public-packages.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const packages = await publicPackages();
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-packages-"));

try {
  for (const packageDescription of packages) {
    const packageRoot = join(root, packageDescription.directory);
    const archive = join(scratch, `${packageDescription.name.replace(/^@/, "").replaceAll("/", "-")}.tgz`);
    await run("pnpm", ["pack", "--out", archive], { cwd: packageRoot });
    const entries = (await run("tar", ["-tzf", archive])).stdout.trim().split("\n");
    const manifest = JSON.parse((await run("tar", ["-xOf", archive, "package/package.json"])).stdout);
    assert(manifest.license === "MIT", `${manifest.name} is missing its MIT license metadata`);
    assert(manifest.repository?.url, `${manifest.name} is missing repository metadata`);
    assert(!entries.some((entry) => /(?:^|\/)src\//.test(entry)), `${manifest.name} publishes source files`);
    assert(!entries.some((entry) => /(?:^|\/)(?:test|tests)\//.test(entry) || /\.test\.[^.]+$/.test(entry)), `${manifest.name} publishes test files`);
    for (const target of exportTargets(manifest.exports)) {
      if (target.includes("*")) continue;
      const entry = `package/${target.replace(/^\.\//, "")}`;
      assert(entries.includes(entry), `${manifest.name} exports missing file ${target}`);
    }
    for (const target of binTargets(manifest.bin)) {
      const entry = `package/${target.replace(/^\.\//, "")}`;
      assert(entries.includes(entry), `${manifest.name} exposes missing executable ${target}`);
      await access(join(packageRoot, target), constants.X_OK).catch(() => {
        throw new Error(`${manifest.name} executable ${target} cannot run from a workspace install`);
      });
    }
    if (manifest.name === "@mdbase-dev/connect") {
      const browserEntry = "package/dist/browser/mdbase-connect.min.js";
      const integrityEntry = "package/dist/browser/integrity.json";
      assert(entries.includes(browserEntry), `${manifest.name} is missing its browser bundle`);
      assert(entries.includes(integrityEntry), `${manifest.name} is missing browser SRI metadata`);
      const bundle = (await run("tar", ["-xOf", archive, browserEntry])).stdout;
      const integrity = JSON.parse((await run("tar", ["-xOf", archive, integrityEntry])).stdout);
      const expected = `sha384-${createHash("sha384").update(bundle).digest("base64")}`;
      assert(integrity.integrity === expected, `${manifest.name} browser SRI metadata is stale`);
      assert(!/(?:^|\\n)\\s*(?:import|export)\\s/m.test(bundle), `${manifest.name} browser bundle has module dependencies`);
      assert(bundle.includes("MdbaseConnect"), `${manifest.name} browser bundle does not expose its global`);
      const installedBundle = await readFile(join(packageRoot, manifest.browser));
      assert(installedBundle.length > 0, `${manifest.name} browser bundle is empty`);
      const browser = {
        URL,
        URLSearchParams,
        AbortController,
        TextEncoder,
        TextDecoder,
        Response,
        crypto: globalThis.crypto,
        fetch: globalThis.fetch,
        atob: globalThis.atob,
        btoa: globalThis.btoa,
        setTimeout,
        clearTimeout
      };
      runInNewContext(bundle, browser);
      assert(
        typeof browser.MdbaseConnect?.MdbaseConnect === "function",
        `${manifest.name} browser global cannot be constructed`
      );
      const portable = new browser.MdbaseConnect.MdbaseConnect({
        serverUrl: "https://connect.example",
        manifest: {
          manifest_version: 1,
          distribution: "portable",
          id: "dev.example.package-audit",
          name: "Package audit"
        }
      });
      assert(
        portable.environment().credentialStorage === "memory",
        `${manifest.name} browser global does not isolate opaque portable credentials`
      );
    }
    process.stdout.write(`${manifest.name} package is consumable (${entries.length} files)\n`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function binTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
