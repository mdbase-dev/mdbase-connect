import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateArchitecture } from "./architecture-check.mjs";

export function counters(result) {
  return {
    productionFiles: result.productionFileCount,
    relativeImports: result.relativeImportCount,
    workspacePackages: result.workspacePackageCount,
    rustPublicDeclarations: result.rustPublicDeclarationCount,
    typeScriptExportDeclarations: result.typeScriptExportDeclarationCount,
    mdbaseCollectionReferences: result.collectionReferenceCount,
    typedCollectionReferences: result.typedCollectionReferenceCount,
    ...result.productionFilesByPackage
  };
}

export async function declarations(root) {
  const directory = path.join(root, "architecture.d");
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(names.sort().map(async (name) => {
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw new Error(`Invalid architecture declaration filename: ${name}`);
    const text = await readFile(path.join(directory, name), "utf8");
    const value = JSON.parse(text);
    if (!value || Object.keys(value).sort().join(",") !== "growth,reason" ||
        typeof value.reason !== "string" || value.reason.trim().length < 20 ||
        !value.growth || Array.isArray(value.growth) || typeof value.growth !== "object" ||
        Object.keys(value.growth).length === 0) {
      throw new Error(`${name}: expected {reason: substantive justification, growth: {counter: positive integer}}`);
    }
    for (const [counter, amount] of Object.entries(value.growth)) {
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`${name}: ${counter} growth must be a positive integer`);
    }
    return { name, text, ...value };
  }));
}

export function compareGrowth(base, head, added) {
  const allowances = Object.create(null);
  const failures = [];
  for (const declaration of added) {
    for (const [counter, amount] of Object.entries(declaration.growth)) {
      if (!Object.hasOwn(head, counter)) failures.push(`${declaration.name}: unknown architecture counter ${counter}.`);
      allowances[counter] = (allowances[counter] ?? 0) + amount;
    }
  }
  for (const [counter, count] of Object.entries(head)) {
    const growth = count - (base[counter] ?? 0);
    if (growth > (allowances[counter] ?? 0)) {
      failures.push(`${counter} grew by ${growth} (${base[counter] ?? 0} -> ${count}); declared allowance is ${allowances[counter] ?? 0}. Reduce growth or justify it in architecture.d/<slug>.json.`);
    }
  }
  return failures;
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

export function architectureBase(root, env = process.env) {
  if (env.ARCHITECTURE_BASE) return env.ARCHITECTURE_BASE;
  // CI must supply the event's base. Never silently compare HEAD to itself.
  if (env.GITHUB_ACTIONS === "true") throw new Error("CI must set ARCHITECTURE_BASE or use --absolute for release verification.");
  return git(root, ["rev-parse", "--verify", "origin/main"]);
}

export async function checkArchitectureGrowth(root, baseRef) {
  const mergeBase = git(root, ["merge-base", "HEAD", baseRef]);
  const snapshot = await mkdtemp(path.join(tmpdir(), "connect-architecture-base-"));
  try {
    const archive = execFileSync("git", ["archive", mergeBase], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", snapshot], { input: archive });
    const budgets = JSON.parse(await readFile(path.join(root, "config/architecture-budgets.json"), "utf8"));
    const baseBudgets = JSON.parse(await readFile(path.join(snapshot, "config/architecture-budgets.json"), "utf8"));
    const base = await evaluateArchitecture(snapshot, baseBudgets, { checkCounters: false });
    const head = await evaluateArchitecture(root, budgets, { checkCounters: false });
    const old = new Map((await declarations(snapshot)).map((entry) => [entry.name, entry.text]));
    const current = await declarations(root);
    const added = current.filter((entry) => !old.has(entry.name));
    for (const entry of current) {
      if (old.has(entry.name) && old.get(entry.name) !== entry.text) head.failures.push(`${entry.name}: existing architecture declarations are immutable; add a new file.`);
    }
    head.failures.push(...compareGrowth(counters(base), counters(head), added));
    return head;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}
