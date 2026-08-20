import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Cargo resolves a `path` dependency against the checkout that happens to be on
// disk, and a `git` dependency against an exact revision. When a sibling
// checkout disagrees with what the manifests pin, the build or the tests fail
// somewhere far from the cause: two copies of one crate in the graph read as a
// type mismatch, and stale fixtures read as a product defect. CI never sees
// any of it, because CI clones exactly the pinned revisions into a clean tree.
// This check exists to name the mismatch before it is mistaken for a bug.

/** Inline tables may span lines, so dependency bodies are matched whole. */
const DEPENDENCY = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*\{([^}]*)\}/gms;

function field(body, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(body);
  return match ? match[1] : undefined;
}

function lineOf(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") line += 1;
  }
  return line;
}

/** Repository directory name implied by a git dependency URL. */
function repositoryName(url) {
  const trimmed = url.replace(/\.git$/, "").replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

async function readManifest(file, root) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return { gitPins: [], pathDependencies: [] };
  }
  const gitPins = [];
  const pathDependencies = [];
  for (const match of source.matchAll(DEPENDENCY)) {
    const [, name, body] = match;
    const where = `${path.relative(root, file) || path.basename(file)}:${lineOf(source, match.index)}`;
    const git = field(body, "git");
    const rev = field(body, "rev");
    if (git && rev) gitPins.push({ name, git, rev, where });
    const dependencyPath = field(body, "path");
    // Only paths that leave this repository can disagree with it.
    if (dependencyPath?.startsWith("../")) {
      pathDependencies.push({ name, path: dependencyPath, where });
    }
  }
  return { gitPins, pathDependencies };
}

/** A repository root plus the crate manifests worth reading inside it. */
async function manifestsOf(repository) {
  const files = [path.join(repository, "Cargo.toml")];
  const cratesDirectory = path.join(repository, "crates");
  let entries = [];
  try {
    entries = await readdir(cratesDirectory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(path.join(cratesDirectory, entry.name, "Cargo.toml"));
    }
  }
  return files;
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** In a linked worktree `.git` is a file, so presence is the test, not kind. */
async function isRepositoryRoot(target) {
  try {
    await stat(path.join(target, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function realGit(repository, args) {
  const { stdout } = await run("git", ["-C", repository, ...args]);
  return stdout.trim();
}

/**
 * Compare every sibling checkout against what the workspace manifests pin.
 *
 * `git` is injectable so the checks can be exercised without real repositories.
 */
export async function evaluateWorkspacePins(root, { git = realGit } = {}) {
  const failures = [];
  const checked = [];

  const rootManifests = await manifestsOf(root);
  const repositories = new Map([[root, rootManifests]]);

  // One level of path dependencies: the sibling this workspace builds against.
  const rootPins = [];
  for (const file of rootManifests) {
    const manifest = await readManifest(file, root);
    rootPins.push(...manifest.gitPins);
    for (const dependency of manifest.pathDependencies) {
      // Cargo resolves a dependency path against the manifest that declares it,
      // not against the workspace root: a crate three levels down writes
      // `../../../sibling`. Resolving from the root instead reports every such
      // dependency as missing.
      const resolved = path.resolve(path.dirname(file), dependency.path);
      // Checked before walking up, because walking up from a missing directory
      // eventually reaches one that does exist and hides the failure.
      if (!(await isDirectory(resolved))) {
        failures.push(
          `${dependency.name} is a path dependency on ${dependency.path}, which does not exist ` +
            `(${dependency.where})`
        );
        continue;
      }
      let candidate = resolved;
      while (
        candidate.startsWith(path.dirname(root)) &&
        !(await isRepositoryRoot(candidate))
      ) {
        const parent = path.dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
      }
      if (!repositories.has(candidate)) {
        repositories.set(candidate, await manifestsOf(candidate));
      }
    }
  }

  // Every git pin reachable from this workspace, wherever it was declared.
  const pins = new Map();
  for (const [repository, files] of repositories) {
    for (const file of files) {
      const manifest = await readManifest(file, repository);
      for (const pin of manifest.gitPins) {
        const scoped = {
          ...pin,
          where: `${path.basename(repository)}/${pin.where}`
        };
        const existing = pins.get(pin.name);
        if (existing) existing.push(scoped);
        else pins.set(pin.name, [scoped]);
      }
    }
  }

  for (const [name, declarations] of pins) {
    const revisions = [...new Set(declarations.map((pin) => pin.rev))];
    if (revisions.length > 1) {
      // Cargo keeps both, so one crate appears twice in the graph and its types
      // stop unifying. The compiler reports that as a type mismatch.
      failures.push(
        `${name} is pinned to ${revisions.length} different revisions, so it will appear more ` +
          `than once in the dependency graph:\n` +
          declarations.map((pin) => `      ${pin.rev.slice(0, 7)}  ${pin.where}`).join("\n")
      );
      continue;
    }
    checked.push(`${name} pinned at ${revisions[0].slice(0, 7)} by ${declarations.length} manifest(s)`);
  }

  // A repository pinned to an exact revision must be at that revision and
  // clean, because tests read its working tree as fixtures rather than reading
  // whatever Cargo vendored.
  for (const [name, declarations] of pins) {
    const rev = declarations[0].rev;
    if (new Set(declarations.map((pin) => pin.rev)).size > 1) continue;
    const sibling = path.resolve(root, "..", repositoryName(declarations[0].git));
    if (!(await isDirectory(sibling))) continue;

    let head;
    try {
      head = await git(sibling, ["rev-parse", "HEAD"]);
    } catch {
      failures.push(`${sibling} is not a readable git checkout`);
      continue;
    }
    let wrong = false;
    if (head !== rev) {
      wrong = true;
      let relation = "";
      try {
        const counts = await git(sibling, ["rev-list", "--left-right", "--count", `${rev}...HEAD`]);
        const [behind, ahead] = counts.split(/\s+/).map(Number);
        if (behind && !ahead) relation = `, ${behind} commit(s) behind the pin`;
        else if (ahead && !behind) relation = `, ${ahead} commit(s) ahead of the pin`;
        else if (ahead && behind) relation = `, diverged (${behind} behind, ${ahead} ahead)`;
      } catch {
        relation = ", and the pinned revision is not present in that checkout";
      }
      failures.push(
        `${path.basename(sibling)} is at ${head.slice(0, 7)} but ${name} pins ` +
          `${rev.slice(0, 7)}${relation}\n` +
          declarations.map((pin) => `      pinned by ${pin.where}`).join("\n") +
          `\n      fix: git -C ${path.relative(root, sibling)} checkout ${rev}`
      );
    }

    // Reported even when the revision is also wrong: a checkout carries its
    // modifications across `git checkout`, so fixing only the revision leaves
    // the tree still not matching the pinned content.
    let status = "";
    try {
      status = await git(sibling, ["status", "--porcelain"]);
    } catch {
      status = "";
    }
    const dirty = status.split("\n").filter((line) => line.trim().length > 0);
    if (dirty.length > 0) {
      failures.push(
        `${path.basename(sibling)} is pinned to an exact revision but has ${dirty.length} ` +
          `modified file(s), so tests reading it as fixtures do not see the pinned content:\n` +
          dirty.slice(0, 5).map((line) => `      ${line.trim()}`).join("\n") +
          (dirty.length > 5 ? `\n      ... and ${dirty.length - 5} more` : "")
      );
    } else if (!wrong) {
      checked.push(`${path.basename(sibling)} is at its pinned revision and clean`);
    }
  }

  return { failures, checked, repositoryCount: repositories.size };
}

export async function checkWorkspacePins(root) {
  return evaluateWorkspacePins(root);
}
