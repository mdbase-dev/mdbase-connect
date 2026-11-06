// Bundle boundary checks. CI fails when an entry bundles a dependency it must not
// carry (the Ajv compiler, yaml) or an entry that must load separately.
import { build } from "esbuild";

// Manifest validators are precompiled in connect-protocol, so the Ajv compiler may
// not return to either entry. yaml parses seed-upgrade baselines synchronously
// during manifest validation, so only the root entry (which validates the app's
// declaration) carries it; the thin client must not.
const entries = [
  { name: "thin-client", entry: "src/thin-client.ts", forbidden: ["ajv", "ajv-formats", "yaml"] },
  { name: "sdk", entry: "src/index.ts", forbidden: ["ajv", "ajv-formats"] },
];

let failed = false;
for (const { name, entry, forbidden: forbiddenPackages } of entries) {
  // Split like an app's bundler does: what loads with the entry is its chunk and
  // the chunks it imports statically. A lazy `import()` (Private collections load
  // the app-grant entry on first use) still may not carry a forbidden dependency.
  const r = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    treeShaking: true,
    metafile: true,
    splitting: true,
    outdir: "bundle-out",
  });
  const outputs = r.metafile.outputs;
  const main = Object.keys(outputs).find((path) => outputs[path].entryPoint);
  const initial = new Set([main]);
  for (const path of initial)
    for (const i of outputs[path].imports) if (i.kind === "import-statement" && outputs[i.path]) initial.add(i.path);
  const inputsOf = (paths) => [...new Set(paths.flatMap((path) => Object.keys(outputs[path].inputs)))];
  const inputs = inputsOf([...initial]);
  const all = inputsOf(Object.keys(outputs));
  // `@mdbase-dev/sdk/app-grant` is a separate entry: neither of these may load it up front.
  const appGrant = inputs.filter((path) => path.startsWith("src/app-grant/"));
  if (appGrant.length) {
    console.error(`${name} bundle includes the app-grant entry: ${appGrant.join(", ")}`);
    failed = true;
  }
  const forbidden = all.filter((path) =>
    forbiddenPackages.some((pkg) => path.includes(`node_modules/${pkg}/`)));
  if (forbidden.length) {
    console.error(`${name} bundle includes ${forbiddenPackages.join("/")}: ${forbidden.slice(0, 5).join(", ")}`);
    failed = true;
  }
  if (name === "thin-client") {
    const application = all.filter((path) => path.startsWith("src/application/") || path.startsWith("src/app-grant/"));
    if (application.length) {
      console.error(`thin-client bundle includes the application entry: ${application.slice(0, 5).join(", ")}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
