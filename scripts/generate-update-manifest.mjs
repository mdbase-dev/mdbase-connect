#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const options = argumentsFrom(process.argv.slice(2));
const directory = required(options, "directory");
const output = required(options, "output");
const version = semanticVersion(required(options, "version"));
const repository = required(options, "repository");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("Invalid GitHub repository.");
const percentage = Number(required(options, "rollout"));
if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
  fail("Rollout percentage must be between 0 and 100.");
}
const tag = `v${version}`;
const releaseUrl = `https://github.com/${repository}/releases/tag/${tag}`;
const downloadRoot = `https://github.com/${repository}/releases/download/${tag}`;
const publishedAt = options.get("published-at")?.[0] ?? new Date().toISOString();
if (!Number.isFinite(Date.parse(publishedAt))) fail("Invalid publication timestamp.");
const blockedVersions = (options.get("blocked-versions")?.[0] ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map(semanticVersion);
if (new Set(blockedVersions).size !== blockedVersions.length) fail("Blocked versions contain duplicates.");
if (blockedVersions.includes(version)) fail("A release cannot block its own target version.");
// The minimum supported version: every published version below it is listed as
// blocked, so those installations get this release at once, bypassing staged
// rollout (an app on a blocked version treats the update as required). The
// manifest schema is unchanged, so older apps still read it.
const minimumVersion = options.get("minimum-version")?.[0];
if (minimumVersion !== undefined) {
  semanticVersion(minimumVersion);
  if (compareVersions(minimumVersion, version) > 0) fail("The minimum version is newer than this release.");
  const published = (options.get("published-versions")?.[0] ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(semanticVersion);
  for (const old of published) {
    if (compareVersions(old, minimumVersion) < 0 && !blockedVersions.includes(old)) blockedVersions.push(old);
  }
  blockedVersions.sort(compareVersions);
}

const names = (await readdir(directory))
  .filter((name) => /^update-input-(macos|windows|linux)-(arm64|x64)\.json$/.test(name))
  .sort();
if (names.length === 0) fail("No update inputs were found.");

const targets = {};
for (const name of names) {
  const input = parseInput(JSON.parse(await readFile(join(directory, name), "utf8")));
  const key = `${platformKey(input.platform)}-${input.arch}`;
  if (targets[key]) fail(`Duplicate update target ${key}.`);
  const artifacts = [];
  if (new Set(input.artifacts).size !== input.artifacts.length) {
    fail(`Update target ${key} contains duplicate artifact names.`);
  }
  for (const artifactName of input.artifacts.sort()) {
    const path = join(directory, artifactName);
    const bundle = `${artifactName}.sigstore.json`;
    await stat(join(directory, bundle));
    const details = await stat(path);
    const digest = await sha256(path);
    artifacts.push({
      name: artifactName,
      url: `${downloadRoot}/${encodeURIComponent(artifactName)}`,
      sigstore_url: `${downloadRoot}/${encodeURIComponent(bundle)}`,
      sha256: digest,
      size: details.size,
      kind: artifactKind(artifactName)
    });
  }
  targets[key] = {
    mode: input.mode,
    action_url: input.action_url === "$RELEASE_URL" ? releaseUrl : httpsUrl(input.action_url),
    artifacts
  };
}

const manifest = {
  schema_version: 1,
  version,
  tag,
  channel: version.includes("-") ? "beta" : "stable",
  published_at: new Date(publishedAt).toISOString(),
  release_url: releaseUrl,
  notes: "See the release page for changes, platform trust information, and recovery guidance.",
  rollout: {
    percentage,
    seed: tag
  },
  blocked_versions: blockedVersions,
  targets
};
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx"
});
console.log(output);

function parseInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid update input.");
  const allowed = ["schema_version", "platform", "arch", "mode", "action_url", "artifacts"];
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !keys.includes(key))) {
    fail("Update input has missing or unknown fields.");
  }
  if (
    value.schema_version !== 1 ||
    !["macos", "windows", "linux"].includes(value.platform) ||
    !["arm64", "x64"].includes(value.arch) ||
    !["automatic", "store", "manual"].includes(value.mode) ||
    typeof value.action_url !== "string" ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.some((name) => typeof name !== "string" || name !== basename(name))
  ) {
    fail("Invalid update input.");
  }
  if (value.mode !== "store" && value.artifacts.length === 0) fail("Update input requires artifacts.");
  return value;
}

function artifactKind(name) {
  const match = /\.(zip|dmg|exe|deb|rpm)$/i.exec(name);
  if (!match) fail(`Unsupported update artifact ${name}.`);
  return match[1].toLowerCase();
}

function platformKey(value) {
  return value === "macos" ? "darwin" : value === "windows" ? "win32" : "linux";
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function compareVersions(left, right) {
  const parse = (value) => {
    const [main, pre] = value.split("-", 2);
    return { main: main.split(".").map(BigInt), pre: pre === undefined ? [] : pre.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.main[index] !== b.main[index]) return a.main[index] < b.main[index] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length === 0 ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const [x, y] = [a.pre[index], b.pre[index]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function semanticVersion(value) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value
    );
  if (
    !match ||
    match[4]?.split(".").some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))
  ) {
    fail(`Invalid semantic version ${value}.`);
  }
  return value;
}

function httpsUrl(value) {
  if (!value.startsWith("https://")) fail("Update action URL must use HTTPS.");
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hash) fail("Unsafe update action URL.");
  return parsed.href;
}

function argumentsFrom(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("Arguments must be --name value pairs.");
    const key = name.slice(2);
    const entries = result.get(key) ?? [];
    entries.push(value);
    result.set(key, entries);
  }
  return result;
}

function required(values, name) {
  const entries = values.get(name);
  if (!entries || entries.length !== 1 || !entries[0]) fail(`--${name} is required once.`);
  return entries[0];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
