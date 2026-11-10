import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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
    /(^|\/)(?:tests|.+_(?:test|tests))\.rs$/.test(file)
  );
}

function matchCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

async function entriesOf(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await entriesOf(directory)) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function productionSources(root) {
  const files = [];
  for (const sourceRoot of SOURCE_ROOTS) files.push(...await walk(path.join(root, sourceRoot)));
  const sources = new Map();
  for (const file of files.sort()) {
    const relative = relativePath(root, file);
    if (!SOURCE_EXTENSIONS.has(path.extname(file)) || isTestFile(relative)) continue;
    sources.set(relative, await readFile(file, "utf8"));
  }
  return sources;
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
  const absolute = path.posix.join(path.posix.dirname(importer), specifier);
  const extension = path.posix.extname(absolute);
  const stem = extension === ".js" || extension === ".mjs" ? absolute.slice(0, -extension.length) : absolute;
  return [
    absolute,
    ...[".ts", ".tsx", ".mts", ".mjs", ".js"].map((suffix) => `${stem}${suffix}`),
    ...[".ts", ".tsx", ".mts", ".mjs", ".js"].map((suffix) => `${absolute}/index${suffix}`)
  ];
}

function canonicalCycle(cycle) {
  const members = cycle.slice(0, -1);
  const rotations = members.map((_, index) => [...members.slice(index), ...members.slice(0, index)]);
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
        const cycle = canonicalCycle([...stack.slice(stack.lastIndexOf(dependency)), dependency]);
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
  return [...cycles.values()].sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
}

function relativeImportGraph(sources) {
  const typeScriptFiles = [...sources.keys()].filter((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)));
  const known = new Set(typeScriptFiles);
  const graph = new Map();
  for (const file of typeScriptFiles) {
    const dependencies = importedSpecifiers(sources.get(file))
      .flatMap((specifier) => importCandidates(file, specifier))
      .filter((candidate) => known.has(candidate));
    graph.set(file, [...new Set(dependencies)].sort());
  }
  return graph;
}

async function workspacePackageGraph(root) {
  const packages = new Map();
  for (const sourceRoot of ["apps", "packages", "services"]) {
    for (const entry of await entriesOf(path.join(root, sourceRoot))) {
      if (!entry.isDirectory()) continue;
      const manifest = await readOptional(path.join(root, sourceRoot, entry.name, "package.json"));
      if (manifest === null) continue;
      const parsed = JSON.parse(manifest);
      if (typeof parsed.name === "string") packages.set(parsed.name, parsed);
    }
  }
  const graph = new Map();
  for (const [name, manifest] of packages) {
    const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
    graph.set(name, Object.keys(dependencies).filter((dependency) => packages.has(dependency)).sort());
  }
  return graph;
}

async function cargoManifests(root) {
  const manifests = [];
  const workspace = await readOptional(path.join(root, "Cargo.toml"));
  if (workspace !== null) manifests.push(["Cargo.toml", workspace]);
  for (const entry of await entriesOf(path.join(root, "crates"))) {
    if (!entry.isDirectory()) continue;
    const file = `crates/${entry.name}/Cargo.toml`;
    const source = await readOptional(path.join(root, file));
    if (source !== null) manifests.push([file, source]);
  }
  return manifests;
}

// Canonical operation outcomes are constructed and read only through mdbase's
// typed API; Connect must not build wire-only values or reach into fields.
const FORBIDDEN_RUST = [
  [/\b(?:CanonicalOperationValue::WireOnly|WireOnlyOperationValue::)\b/g, "direct wire-only operation value constructor"],
  [/\bCanonicalOperationOutcome\s*\{\s*(?:valid|value|diagnostics)\s*:/g, "direct CanonicalOperationOutcome struct literal"],
  [/\boperation\.(?:valid|value|diagnostics)\b(?!\s*\()/g, "private canonical outcome field access"]
];

const PROJECTION_ASSERTION =
  /const\s+_\s*:\s*\(\)\s*=\s*assert!\(\s*mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION\s*==\s*CONNECT_SEMANTIC_PROJECTION_FORMAT_VERSION\s*\)\s*;/s;

export async function evaluateArchitecture(root) {
  const sources = await productionSources(root);
  const failures = [];

  for (const [file, source] of sources) {
    if (!file.endsWith(".rs")) continue;
    for (const [pattern, description] of FORBIDDEN_RUST) {
      const count = matchCount(source, pattern);
      if (count > 0) failures.push(`${file} has ${count} forbidden ${description}(s).`);
    }
  }

  for (const [manifest, source] of await cargoManifests(root)) {
    if (/\bfeatures\s*=\s*\[[^\]]*["']legacy-collection-mutation["'][^\]]*\]/s.test(source)) {
      failures.push(`${manifest} enables the legacy-collection-mutation feature.`);
    }
    for (const dependency of source.matchAll(/^\s*mdbase\s*=\s*\{([^}]*)\}/gm)) {
      const options = dependency[1];
      if (!/\bworkspace\s*=\s*true\b/.test(options) && !/\bdefault-features\s*=\s*false\b/.test(options)) {
        failures.push(`${manifest} mdbase dependency must set default-features = false.`);
      }
    }
  }

  const provider = sources.get("crates/connect-hosted-provider/src/provider.rs");
  if (provider !== undefined && !PROJECTION_ASSERTION.test(provider)) {
    failures.push("hosted provider must compile-assert the upstream semantic projection format.");
  }

  for (const cycle of graphCycles(relativeImportGraph(sources))) {
    failures.push(`Relative import cycle: ${cycle.join(" -> ")}`);
  }
  for (const cycle of graphCycles(await workspacePackageGraph(root))) {
    failures.push(`Workspace package cycle: ${cycle.join(" -> ")}`);
  }

  return failures;
}
