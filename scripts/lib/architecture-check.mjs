import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOTS = ["apps", "crates", "packages", "services"];
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".mts", ".rs", ".ts", ".tsx"]);
const TYPESCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".mts", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set(["dist", "node_modules", "out", "target"]);

function relativePath(root, value) {
  return path.relative(root, value).split(path.sep).join("/");
}

function isTestFile(file) {
  return (
    /(^|\/)(test|tests)\//.test(file) ||
    /\.(spec|test)\.[^.]+$/.test(file) ||
    /(^|\/)tests\.rs$/.test(file)
  );
}

function isGeneratedFile(file) {
  return /\.generated\.[^.]+$/.test(file);
}

function lineCount(source) {
  if (source.length === 0) return 0;
  const lines = source.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

async function sourceFiles(root) {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const directory = path.join(root, sourceRoot);
    try {
      files.push(...await walk(directory));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .sort();
}

function importedSpecifiers(source) {
  const specifiers = [];
  const staticImport =
    /(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/gs;
  const dynamicImport = /import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function importCandidates(importer, specifier) {
  const absolute = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(absolute);
  const withoutJavaScriptExtension =
    extension === ".js" || extension === ".mjs"
      ? absolute.slice(0, -extension.length)
      : absolute;
  const candidates = [
    absolute,
    `${withoutJavaScriptExtension}.ts`,
    `${withoutJavaScriptExtension}.tsx`,
    `${withoutJavaScriptExtension}.mts`,
    `${withoutJavaScriptExtension}.mjs`,
    `${withoutJavaScriptExtension}.js`,
    path.join(absolute, "index.ts"),
    path.join(absolute, "index.tsx"),
    path.join(absolute, "index.mts"),
    path.join(absolute, "index.mjs"),
    path.join(absolute, "index.js")
  ];
  return [...new Set(candidates.map(path.normalize))];
}

function canonicalCycle(cycle) {
  const members = cycle.slice(0, -1);
  const rotations = members.map((_, index) => [
    ...members.slice(index),
    ...members.slice(0, index)
  ]);
  rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
  return [...rotations[0], rotations[0][0]];
}

function graphCycles(graph) {
  const state = new Map();
  const stack = [];
  const cycles = new Map();

  function visit(node) {
    state.set(node, "visiting");
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!graph.has(dependency)) continue;
      if (state.get(dependency) === "visiting") {
        const start = stack.lastIndexOf(dependency);
        const cycle = canonicalCycle([...stack.slice(start), dependency]);
        cycles.set(cycle.join("\0"), cycle);
      } else if (!state.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(node, "visited");
  }

  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) visit(node);
  }
  return [...cycles.values()].sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0"))
  );
}

async function relativeImportGraph(root, files) {
  const typeScriptFiles = files.filter(
    (file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)) &&
      !isTestFile(relativePath(root, file))
  );
  const knownFiles = new Set(typeScriptFiles.map(path.normalize));
  const graph = new Map();
  for (const file of typeScriptFiles) {
    const source = await readFile(file, "utf8");
    const dependencies = importedSpecifiers(source)
      .flatMap((specifier) => importCandidates(file, specifier))
      .filter((candidate) => knownFiles.has(candidate));
    graph.set(path.normalize(file), [...new Set(dependencies)].sort());
  }
  return graph;
}

async function workspacePackageGraph(root) {
  const packageFiles = [];
  for (const sourceRoot of ["apps", "packages", "services"]) {
    const directory = path.join(root, sourceRoot);
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) packageFiles.push(path.join(directory, entry.name, "package.json"));
    }
  }

  const packages = new Map();
  for (const packageFile of packageFiles) {
    try {
      const manifest = JSON.parse(await readFile(packageFile, "utf8"));
      if (typeof manifest.name === "string") packages.set(manifest.name, manifest);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const graph = new Map();
  for (const [name, manifest] of packages) {
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies
    };
    graph.set(
      name,
      Object.keys(dependencies).filter((dependency) => packages.has(dependency)).sort()
    );
  }
  return graph;
}

export async function evaluateArchitecture(root, budgets) {
  const files = await sourceFiles(root);
  const failures = [];
  const productionFiles = files.filter((file) => !isTestFile(relativePath(root, file)));
  const legacyBudgets = budgets.legacyFileLineBudgets ?? {};
  const productionFileMaxLines = budgets.productionFileMaxLines;

  if (!Number.isSafeInteger(productionFileMaxLines) || productionFileMaxLines < 1) {
    failures.push("productionFileMaxLines must be a positive integer.");
  }

  const measured = new Map();
  for (const file of productionFiles.filter((file) => !isGeneratedFile(relativePath(root, file)))) {
    const relative = relativePath(root, file);
    const lines = lineCount(await readFile(file, "utf8"));
    measured.set(relative, lines);
    const maximum = legacyBudgets[relative] ?? productionFileMaxLines;
    if (lines > maximum) {
      failures.push(`${relative} has ${lines} lines; its budget is ${maximum}.`);
    }
  }

  for (const [file, maximum] of Object.entries(legacyBudgets)) {
    if (!Number.isSafeInteger(maximum) || maximum <= productionFileMaxLines) {
      failures.push(
        `${file} has an invalid legacy budget; exceptions must exceed ${productionFileMaxLines}.`
      );
    } else if (!measured.has(file)) {
      failures.push(`${file} has a legacy budget but is not a production source file.`);
    }
  }

  const importGraph = await relativeImportGraph(root, files);
  for (const cycle of graphCycles(importGraph)) {
    failures.push(
      `Relative import cycle: ${cycle.map((file) => relativePath(root, file)).join(" -> ")}`
    );
  }

  const packageGraph = await workspacePackageGraph(root);
  for (const cycle of graphCycles(packageGraph)) {
    failures.push(`Workspace package cycle: ${cycle.join(" -> ")}`);
  }

  return {
    failures,
    productionFileCount: productionFiles.length,
    relativeImportCount: [...importGraph.values()].reduce(
      (total, dependencies) => total + dependencies.length,
      0
    ),
    workspacePackageCount: packageGraph.size
  };
}

export async function checkArchitecture(root) {
  const budgetPath = path.join(root, "config", "architecture-budgets.json");
  const budgets = JSON.parse(await readFile(budgetPath, "utf8"));
  return evaluateArchitecture(root, budgets);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  const result = await checkArchitecture(root);
  for (const failure of result.failures) console.error(`- ${failure}`);
  if (result.failures.length > 0) process.exitCode = 1;
  else {
    console.log(
      `Architecture check passed: ${result.productionFileCount} production files, ` +
      `${result.relativeImportCount} relative imports, ` +
      `${result.workspacePackageCount} workspace packages.`
    );
  }
}
