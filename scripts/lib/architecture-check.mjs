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
    /(^|\/)(?:tests|.+_(?:test|tests))\.rs$/.test(file)
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

function matchCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function packagePath(file) {
  return file.split("/").slice(0, 2).join("/");
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
  const packagePaths = new Set();
  for (const packageFile of packageFiles) {
    try {
      const manifest = JSON.parse(await readFile(packageFile, "utf8"));
      packagePaths.add(relativePath(root, path.dirname(packageFile)));
      if (typeof manifest.name === "string") {
        packages.set(manifest.name, manifest);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const cratesDirectory = path.join(root, "crates");
  try {
    const crateEntries = await readdir(cratesDirectory, { withFileTypes: true });
    for (const entry of crateEntries) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(path.join(cratesDirectory, entry.name, "Cargo.toml"), "utf8");
        packagePaths.add(`crates/${entry.name}`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
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
  return { graph, packagePaths };
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
  const productionSources = new Map();
  for (const file of productionFiles) {
    const relative = relativePath(root, file);
    const source = await readFile(file, "utf8");
    productionSources.set(relative, source);
    if (isGeneratedFile(relative)) continue;
    const lines = lineCount(source);
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

  const productionFilesByPackage = {};
  for (const relative of productionSources.keys()) {
    const packageName = packagePath(relative);
    productionFilesByPackage[packageName] = (productionFilesByPackage[packageName] ?? 0) + 1;
  }
  const workspaceInventory = await workspacePackageGraph(root);
  const packageBudgets = budgets.productionFileBudgetsByPackage;
  if (packageBudgets) {
    const knownPackagePaths = new Set(Object.keys(productionFilesByPackage));
    for (const packageName of workspaceInventory.packagePaths) {
      knownPackagePaths.add(packageName);
    }
    for (const packageName of [...knownPackagePaths].sort()) {
      const count = productionFilesByPackage[packageName] ?? 0;
      const maximum = packageBudgets[packageName];
      if (!Number.isSafeInteger(maximum)) {
        failures.push(`${packageName} has ${count} production files but no package budget.`);
      } else if (count > maximum) {
        failures.push(`${packageName} has ${count} production files; its budget is ${maximum}.`);
      }
    }
    for (const packageName of Object.keys(packageBudgets)) {
      if (!knownPackagePaths.has(packageName)) {
        failures.push(`${packageName} has a package budget but is not a source or workspace package.`);
      }
    }
  }

  const deadCodeReferencesByFile = {};
  let rustPublicDeclarationCount = 0;
  let typeScriptExportDeclarationCount = 0;
  let collectionReferenceCount = 0;
  let typedCollectionReferenceCount = 0;
  for (const [relative, source] of productionSources) {
    if (path.extname(relative) === ".rs") {
      const deadCode = matchCount(source, /\bdead_code\b/g);
      if (deadCode > 0) deadCodeReferencesByFile[relative] = deadCode;
      rustPublicDeclarationCount += matchCount(source, /\bpub(?:\([^)]*\))?\b/g);
    } else if (TYPESCRIPT_EXTENSIONS.has(path.extname(relative))) {
      typeScriptExportDeclarationCount += matchCount(source, /\bexport\b/g);
    }
    collectionReferenceCount += matchCount(source, /\bmdbase::Collection\b/g);
    typedCollectionReferenceCount += matchCount(source, /\bTypedCollection\b/g);
  }

  const deadCodeBudgets = budgets.deadCodeReferencesByFile;
  if (deadCodeBudgets) {
    for (const [file, count] of Object.entries(deadCodeReferencesByFile)) {
      const maximum = deadCodeBudgets[file];
      if (!Number.isSafeInteger(maximum)) {
        failures.push(`${file} has ${count} unregistered dead-code reference(s).`);
      } else if (count > maximum) {
        failures.push(`${file} has ${count} dead-code references; its budget is ${maximum}.`);
      }
    }
    for (const file of Object.keys(deadCodeBudgets)) {
      if (!(file in deadCodeReferencesByFile)) {
        failures.push(`${file} has a dead-code budget but no production dead-code reference.`);
      }
    }
  }

  const localRuntimeFiles = [
    "crates/connect-core/src/registry/runtime_operations.rs",
    "crates/connect-core/src/registry/runtime_executor.rs"
  ];
  for (const file of localRuntimeFiles) {
    const source = productionSources.get(file);
    if (!source) continue;
    const forbidden = [
      [/\.result\.result\b/g, "deprecated nested OperationResult access"],
      [/pointer\(["']\/result\/(?:frontmatter|types)["']\)/g, "record JSON-pointer inspection"],
      [/serde_json::from_value[^\n]*(?:RecordDocument|CanonicalOperation)/g, "typed outcome recovery through JSON"]
    ];
    for (const [pattern, description] of forbidden) {
      const count = matchCount(source, pattern);
      if (count > 0) failures.push(`${file} has ${count} forbidden ${description} seam(s).`);
    }
    const operationResults = matchCount(source, /mdbase::v03::OperationResult/g);
    const allowedBoundaryAdapters = file.endsWith("runtime_operations.rs") ? 1 : 0;
    if (operationResults > allowedBoundaryAdapters) {
      failures.push(`${file} has ${operationResults} internal OperationResult reference(s); only ${allowedBoundaryAdapters} boundary adapter reference(s) are allowed.`);
    }
  }
  if (productionSources.has("crates/connect-core/src/registry/runtime_operations.rs")) {
    const connectCoreToV03 = [...productionSources]
      .filter(([file]) => file.startsWith("crates/connect-core/src/"))
      .reduce((total, [, source]) => total + matchCount(source, /\.to_v03\(/g), 0);
    if (connectCoreToV03 !== 1) {
      failures.push(`connect-core must have exactly one v0.3 boundary adapter; found ${connectCoreToV03} to_v03 call(s).`);
    }
  }

  if (budgets.externalGuards !== undefined) {
    const externalGuards = budgets.externalGuards ?? {};
    const guardedRust = [...productionSources]
      .filter(([file]) => file.endsWith(".rs"))
      .map(([, source]) => source)
      .join("\n");
    const guardedCounts = {
      directWireOnlyConstructors: matchCount(
        guardedRust,
        /\b(?:CanonicalOperationValue::WireOnly|WireOnlyOperationValue::)\b/g
      ),
      directCanonicalOutcomeStructs: matchCount(
        guardedRust,
        /\bCanonicalOperationOutcome\s*\{\s*(?:valid|value|diagnostics)\s*:/g
      ),
      privateCanonicalResultFieldCalls: matchCount(
        guardedRust,
        /\boperation\.(?:valid|value|diagnostics)\b(?!\s*\()/g
      )
    };
    for (const [name, count] of Object.entries(guardedCounts)) {
      const maximum = externalGuards[name];
      if (!Number.isSafeInteger(maximum) || maximum < 0) {
        failures.push(`externalGuards.${name} must be a non-negative integer.`);
      } else if (count > maximum) {
        failures.push(`${name} is ${count}; its external guard is ${maximum}.`);
      }
    }

    const cargoManifestPaths = [
      "Cargo.toml",
      ...[...workspaceInventory.packagePaths]
        .filter((packagePath) => packagePath.startsWith("crates/"))
        .map((packagePath) => `${packagePath}/Cargo.toml`)
    ];
    const cargoSources = [];
    for (const manifest of cargoManifestPaths) {
      try {
        cargoSources.push([manifest, await readFile(path.join(root, manifest), "utf8")]);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const legacyCrudFeatures = cargoSources.reduce(
      (total, [, source]) => total + matchCount(
        source,
        /\bfeatures\s*=\s*\[[^\]]*["']legacy-collection-mutation["'][^\]]*\]/gs
      ),
      0
    );
    if (legacyCrudFeatures !== (externalGuards.legacyCrudFeatures ?? -1)) {
      failures.push(
        `legacyCrudFeatures is ${legacyCrudFeatures}; expected ${externalGuards.legacyCrudFeatures}.`
      );
    }
    for (const [manifest, source] of cargoSources) {
      for (const dependency of source.matchAll(/^\s*mdbase\s*=\s*\{([^}]*)\}/gm)) {
        const options = dependency[1];
        if (!/\bworkspace\s*=\s*true\b/.test(options) &&
            !/\bdefault-features\s*=\s*false\b/.test(options)) {
          failures.push(`${manifest} mdbase dependency must set default-features = false.`);
        }
      }
    }

    const projectionFormat = externalGuards.semanticProjectionFormatVersion;
    if (!Number.isSafeInteger(projectionFormat) || projectionFormat < 1) {
      failures.push("externalGuards.semanticProjectionFormatVersion must be a positive integer.");
    } else {
      const hostedProvider = productionSources.get(
        "crates/connect-hosted-provider/src/provider.rs"
      ) ?? "";
      const configuredFormat = new RegExp(
        `const\\s+CONNECT_SEMANTIC_PROJECTION_FORMAT_VERSION\\s*:\\s*u32\\s*=\\s*${projectionFormat}\\s*;`
      );
      const compileAssertion = /const\s+_\s*:\s*\(\)\s*=\s*assert!\(\s*mdbase::runtime::SEMANTIC_PROJECTION_FORMAT_VERSION\s*==\s*CONNECT_SEMANTIC_PROJECTION_FORMAT_VERSION\s*\)\s*;/s;
      if (!configuredFormat.test(hostedProvider) || !compileAssertion.test(hostedProvider)) {
        failures.push(
          `hosted provider must compile-assert upstream semantic projection format ${projectionFormat}.`
        );
      }
    }
  }

  const reviewBudgets =
    budgets.reviewBudgets && typeof budgets.reviewBudgets === "object" && !Array.isArray(budgets.reviewBudgets)
      ? budgets.reviewBudgets
      : {};
  const supportedReviewBudgets = new Set([
    "productionFiles",
    "relativeImports",
    "workspacePackages",
    "rustPublicDeclarations",
    "typeScriptExportDeclarations",
    "mdbaseCollectionReferences",
    "typedCollectionReferences"
  ]);
  if (reviewBudgets !== budgets.reviewBudgets) {
    failures.push("reviewBudgets must be an object with every reviewed surface.");
  }
  for (const name of supportedReviewBudgets) {
    if (!(name in reviewBudgets)) {
      failures.push(`reviewBudgets.${name} is required.`);
    }
  }
  for (const [name, maximum] of Object.entries(reviewBudgets)) {
    if (!supportedReviewBudgets.has(name)) {
      failures.push(`reviewBudgets.${name} is not a supported reviewed surface.`);
    } else if (!Number.isSafeInteger(maximum) || maximum < 0) {
      failures.push(`reviewBudgets.${name} must be a non-negative integer.`);
    }
  }

  const reviewedCounts = {
    productionFiles: productionFiles.length,
    rustPublicDeclarations: rustPublicDeclarationCount,
    typeScriptExportDeclarations: typeScriptExportDeclarationCount,
    mdbaseCollectionReferences: collectionReferenceCount,
    typedCollectionReferences: typedCollectionReferenceCount
  };
  for (const [name, count] of Object.entries(reviewedCounts)) {
    const maximum = reviewBudgets[name];
    if (Number.isSafeInteger(maximum) && count > maximum) {
      failures.push(`${name} is ${count}; its reviewed budget is ${maximum}.`);
    }
  }

  const importGraph = await relativeImportGraph(root, files);
  for (const cycle of graphCycles(importGraph)) {
    failures.push(
      `Relative import cycle: ${cycle.map((file) => relativePath(root, file)).join(" -> ")}`
    );
  }

  const packageGraph = workspaceInventory.graph;
  for (const cycle of graphCycles(packageGraph)) {
    failures.push(`Workspace package cycle: ${cycle.join(" -> ")}`);
  }

  const relativeImportCount = [...importGraph.values()].reduce(
    (total, dependencies) => total + dependencies.length,
    0
  );
  if (Number.isSafeInteger(reviewBudgets.relativeImports) && reviewBudgets.relativeImports >= 0 && relativeImportCount > reviewBudgets.relativeImports) {
    failures.push(
      `relativeImports is ${relativeImportCount}; its reviewed budget is ${reviewBudgets.relativeImports}.`
    );
  }
  const workspacePackageCount = workspaceInventory.packagePaths.size;
  if (Number.isSafeInteger(reviewBudgets.workspacePackages) && reviewBudgets.workspacePackages >= 0 && workspacePackageCount > reviewBudgets.workspacePackages) {
    failures.push(
      `workspacePackages is ${workspacePackageCount}; its reviewed budget is ${reviewBudgets.workspacePackages}.`
    );
  }

  return {
    failures,
    productionFileCount: productionFiles.length,
    productionFilesByPackage,
    relativeImportCount,
    workspacePackageCount,
    rustPublicDeclarationCount,
    typeScriptExportDeclarationCount,
    deadCodeReferencesByFile,
    collectionReferenceCount,
    typedCollectionReferenceCount
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
      `${result.workspacePackageCount} workspace packages; ` +
      `${result.rustPublicDeclarationCount} Rust public declarations, ` +
      `${result.typeScriptExportDeclarationCount} TypeScript export declarations.`
    );
  }
}
