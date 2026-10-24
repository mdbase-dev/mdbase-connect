// Assert that every workspace with a vendored `file:*.tgz` dependency resolves
// that dependency to the bytes of its own tarball.
//
// Several workspaces vendor SDK builds that share one package name and version
// (`@mdbase-dev/sdk@0.0.0`). With the hoisted linker, pnpm may place either copy
// at the root `node_modules`, and a workspace that finds no copy of its own
// resolves the hoisted one: an image then bundles the wrong SDK while every
// version check still passes. This compares the installed package, located with
// Node's own lookup from the workspace directory, against the tarball contents
// file by file, and refuses two different tarballs with one name@version.
// Bundled dependencies (`node_modules/` inside the tarball) are
// skipped; the package's own files identify the build.
//
//   node scripts/check-vendored-sdk.mjs [WORKSPACE_DIR...]
//
// With no arguments every pnpm workspace package is checked. Exit 1 on a
// mismatch or a missing install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workspaceDirs() {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const match = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/);
      if (match) globs.push(match[1]);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  const dirs = [];
  for (const glob of globs) {
    if (glob.startsWith("!")) continue;
    if (glob.endsWith("/*")) {
      const parent = join(root, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const name of readdirSync(parent)) {
        const dir = join(parent, name);
        if (existsSync(join(dir, "package.json"))) dirs.push(dir);
      }
    } else if (existsSync(join(root, glob, "package.json"))) {
      dirs.push(join(root, glob));
    }
  }
  return dirs;
}

function vendoredDependencies(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const result = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("file:") && spec.endsWith(".tgz")) {
        result.push({ name, tarball: resolve(dir, spec.slice("file:".length)) });
      }
    }
  }
  return result;
}

// Node's module lookup: the nearest `node_modules/<name>` walking up from dir.
export function installedPackageDir(dir, name) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(current) === current) return null;
  }
}

function files(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path === join(base, "node_modules")) continue;
      files(path, base, out);
    } else if (entry.isFile()) {
      out.push(relative(base, path).split(sep).join("/"));
    }
  }
  return out;
}

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function compareInstalled(installed, tarball) {
  const scratch = mkdtempSync(join(tmpdir(), "vendored-sdk-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", scratch]);
    const unpacked = join(scratch, "package");
    const expected = files(unpacked);
    if (expected.length === 0) return [`${tarball} has no package files`];
    const problems = [];
    for (const file of expected) {
      const target = join(installed, file);
      if (!existsSync(target) || !statSync(target).isFile()) problems.push(`missing ${file}`);
      else if (digest(target) !== digest(join(unpacked, file))) problems.push(`differs ${file}`);
    }
    return problems;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Distinct tarballs that declare the same name@version are the root cause: the
// installer may treat them as one package. Identical bytes in two places are fine.
export function sameNameCollisions(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    for (const { tarball } of vendoredDependencies(dir)) {
      if (!existsSync(tarball)) continue;
      const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
      const key = `${manifest.name}@${manifest.version}`;
      const byDigest = seen.get(key) ?? new Map();
      byDigest.set(digest(tarball), relative(root, tarball));
      seen.set(key, byDigest);
    }
  }
  return [...seen].filter(([, byDigest]) => byDigest.size > 1)
    .map(([key, byDigest]) => `${key} is vendored as ${byDigest.size} different tarballs (${[...byDigest.values()].sort().join(", ")}); vendor one tarball or give each build its own version`);
}

export function checkWorkspace(dir) {
  const failures = [];
  let checked = 0;
  for (const { name, tarball } of vendoredDependencies(dir)) {
    const label = `${relative(root, dir) || "."}: ${name} (${relative(root, tarball)})`;
    if (!existsSync(tarball)) { failures.push(`${label}: tarball not found`); continue; }
    const installed = installedPackageDir(dir, name);
    if (!installed) { failures.push(`${label}: not installed`); continue; }
    const problems = compareInstalled(installed, tarball);
    checked += 1;
    if (problems.length) {
      failures.push(`${label}: resolves to ${relative(root, installed)}, which is not this tarball (${problems.length} files: ${problems.slice(0, 3).join(", ")})`);
    } else {
      console.log(`ok ${label} -> ${relative(root, installed)}`);
    }
  }
  return { checked, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2).map((dir) => resolve(dir)) : workspaceDirs();
  let checked = 0;
  const failures = sameNameCollisions(dirs);
  for (const dir of dirs) {
    const result = checkWorkspace(dir);
    checked += result.checked;
    failures.push(...result.failures);
  }
  for (const failure of failures) console.error(`vendored dependency mismatch: ${failure}`);
  if (failures.length) process.exit(1);
  console.log(`${checked} vendored dependencies resolve to their own tarballs.`);
}
