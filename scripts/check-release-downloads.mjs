import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ignored = new Set([".git", "node_modules", "vendor", "dist", "coverage", ".ops", "target", "build", "out"]);
const dangerous = /github\.com\/[^\s"'`]*\/releases\/download\/|objects\.githubusercontent\.com/;
const source = /\.(?:[cm]?[jt]s|sh|ps1|py|rb|ya?ml)$/;

async function files(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else {
      const name = relative(root, path).replaceAll("\\", "/");
      if (/(?:^|\/)(?:test|tests|fixtures)\//.test(name) || /(?:\.test\.|\.node-test\.)/.test(name)) continue;
      if ((/^(?:\.github|bin|tools|deploy|release)\//.test(name) || /(?:^|\/)scripts\//.test(name)) && (source.test(name) || !entry.name.includes("."))) result.push(path);
      else if (entry.name === "package.json") result.push(path);
    }
  }
  return result;
}

export async function checkReleaseDownloads(root) {
  let allowlist = [];
  try {
    allowlist = JSON.parse(await readFile(join(root, ".github/release-download-allowlist.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const allowed = new Set(allowlist.map(entry => {
    if (!entry.reason || !entry.path || !entry.line) throw Error("Release download allowlist requires a path, exact line and reason");
    return `${entry.path}:${entry.line}`;
  }));
  const seen = new Set();
  const failures = [];
  for (const path of await files(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    const text = await readFile(path, "utf8");
    text.split("\n").forEach((line, index) => {
      if (!dangerous.test(line) && !line.includes(["browser", "download", "url"].join("_"))) return;
      const key = `${name}:${line.trim()}`;
      if (allowed.has(key)) seen.add(key);
      else failures.push(`${name}:${index + 1}: release URL must use the authenticated asset API or an audited use`);
    });
    if (!/^\.github\/workflows\/.*\.ya?ml$/.test(name)) continue;
    for (const job of text.split(/\n(?= {2}[\w-]+:)/)) {
      const invocation = job.search(/\bworker-build\s+--(?:release|dev|debug|locked)\b/);
      if (invocation >= 0 && !job.slice(0, invocation).includes("run: node scripts/ci/prefetch-worker-tools.mjs")) failures.push(`${name}: worker-build requires an earlier authenticated tool prefetch in the same job`);
    }
    for (const rawStep of text.split(/\n(?= {6}- )/).slice(1)) {
      const step = rawStep.split("\n").filter(line => !/^\s*#/.test(line)).join("\n");
      const jobToken = /\bGITHUB_TOKEN: \$\{\{ github\.token \}\}/.test(step);
      const ghToken = /\bGH_TOKEN: \$\{\{ github\.token \}\}/.test(step);
      if (/\/(?:publisher|native)\/(?:publisher\.mjs guard|install-inputs\.mjs|build\.mjs)/.test(step) && !jobToken) failures.push(`${name}: SDK original intake/install/comparison requires its step-scoped job token`);
      if (/\bgh release download\b|\bbin\/install-(?:render-cli|cosign)\s/.test(step) && !ghToken && !jobToken) failures.push(`${name}: release CLI download requires its step-scoped job token`);
      if (/uses: docker\/setup-buildx-action@/.test(step) && !/GITHUB_TOKEN: token \$\{\{ github\.token \}\}/.test(step)) failures.push(`${name}: Buildx downloads require an authenticated HTTP Authorization value`);
      if (/uses: actions\/setup-java@/.test(step) && !/distribution: jdkfile/.test(step)) failures.push(`${name}: Java release assets must be authenticated before setup-java extracts them`);
      if (/run: node scripts\/ci\/prefetch-java\.mjs/.test(step) && !jobToken) failures.push(`${name}: Java asset prefetch requires its step-scoped job token`);
      if (/run: node scripts\/ci\/prefetch-worker-tools\.mjs/.test(step) && !jobToken) failures.push(`${name}: worker-build tool prefetch requires its step-scoped job token`);
    }
  }
  for (const key of allowed) if (!seen.has(key)) failures.push(`${key.split(":")[0]}: stale release-download allowlist entry`);
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await checkReleaseDownloads(process.cwd());
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Release downloads: authenticated transports and audited URL uses");
}
