#!/usr/bin/env node
// Build or verify the pinned SDK archive the self-hosted app entries install.
//
//   node scripts/direct-archive.mjs build <commit> <output directory>
//   node scripts/direct-archive.mjs verify <facts.json>...
//
// The archive is built only from a committed tree of this package. The tree id is
// its source identity; the commit says where to fetch it. `verify` rebuilds from
// that tree and compares bytes.
// This is not the published SDK and does not replace its publication gates.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = "runtime/packages/sdk";
const steps = ["npm ci --ignore-scripts", "tsc -p tsconfig.build.json", "npm pack --ignore-scripts"];
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const toolchain = () => ({ node: process.version, npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() });

function pack(tree) {
  const work = mkdtempSync(join(tmpdir(), "direct-sdk-"));
  try {
    const source = execFileSync("git", ["archive", "--format=tar", tree], { cwd: repo, maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", work], { input: source });
    const run = (command, ...args) => execFileSync(command, args, { cwd: work, stdio: ["ignore", "ignore", "inherit"] });
    run("npm", "ci", "--ignore-scripts", "--loglevel=error");
    run(join(work, "node_modules/.bin/tsc"), "-p", "tsconfig.build.json");
    run("npm", "pack", "--ignore-scripts", "--loglevel=error");
    const [archive, ...others] = readdirSync(work).filter(name => name.endsWith(".tgz"));
    assert(archive && !others.length, "npm pack must produce exactly one archive");
    const manifest = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
    return { bytes: readFileSync(join(work, archive)), name: manifest.name, version: manifest.version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const digest = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

const [action, ...args] = process.argv.slice(2);
if (action === "build" && args.length === 2) {
  const commit = git("rev-parse", "--verify", `${args[0]}^{commit}`);
  const tree = git("rev-parse", "--verify", `${commit}:${packagePath}`);
  const { bytes, name, version } = pack(tree);
  const sha256 = digest("sha256", bytes, "hex");
  const artifact = `sdk-self-hosted-${sha256}.tgz`;
  const out = resolve(args[1]);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, artifact), bytes);
  writeFileSync(join(out, artifact.replace(/\.tgz$/, ".json")), JSON.stringify({
    schema: "mdbase/direct-sdk-archive/1",
    artifact,
    package: name,
    version,
    bytes: bytes.length,
    sha256,
    sri: `sha512-${digest("sha512", bytes, "base64")}`,
    source: { repository: "mdbase-dev/mdbase-connect", commit, path: packagePath, tree },
    toolchain: toolchain(),
    build: steps,
  }, null, 2) + "\n");
  console.log(join(out, artifact));
} else if (action === "verify" && args.length) {
  for (const file of args) {
    const facts = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(facts.schema, "mdbase/direct-sdk-archive/1");
    assert.equal(basename(file), facts.artifact.replace(/\.tgz$/, ".json"));
    const stored = readFileSync(join(dirname(resolve(file)), facts.artifact));
    assert.equal(digest("sha256", stored, "hex"), facts.sha256, `${facts.artifact} differs from its recorded digest`);
    assert.equal(facts.artifact, `sdk-self-hosted-${facts.sha256}.tgz`);
    const rebuilt = digest("sha256", pack(facts.source.tree).bytes, "hex");
    assert.equal(rebuilt, facts.sha256,
      `rebuilding ${facts.source.tree} with ${JSON.stringify(toolchain())} gave ${rebuilt}; the archive records ${JSON.stringify(facts.toolchain)}`);
    console.log(`${file}: reproduced ${facts.sha256} from tree ${facts.source.tree}`);
  }
} else {
  console.error("Usage: direct-archive.mjs build <commit> <output directory> | verify <facts.json>...");
  process.exit(2);
}
