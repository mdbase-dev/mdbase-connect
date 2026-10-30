// Bundle-size checks, minified and gzipped. CI fails when an entry exceeds its
// ceiling or bundles a dependency it must not carry (the Ajv compiler, yaml).
//
// - `@mdbase-dev/sdk/thin-client` is the thin client (codec, client, records, Noise,
//   relay transport, keys) for Obsidian-plugin-style consumers. replica-client-api.md
//   §12.3 expects "a few tens of KiB"; its ceiling is 68 KiB (66.1 KiB measured
//   after Bases reads moved onto authenticated replica frames for Private
//   collections).
// - The root entry adds the application entry (`MdbaseConnect`, with precompiled
//   manifest validators), people, timers, notifications and error copy. Standalone
//   apps have no product size limit; its ceiling is the measured size plus a small
//   margin, so unintended growth fails here instead of shipping silently.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const KiB = 1024;
// Manifest validators are precompiled in connect-protocol, so the Ajv compiler may
// not return to either entry. yaml parses seed-upgrade baselines synchronously
// during manifest validation, so only the root entry (which validates the app's
// declaration) carries it; the thin client must not.
const entries = [
  { name: "thin-client", entry: "src/thin-client.ts", ceiling: 68 * KiB, forbidden: ["ajv", "ajv-formats", "yaml"] },
  // Measured at 173.4 KiB once the UI session runtime loads on activation
  // (#975). 176 KiB is the measured root-entry tripwire plus a small margin.
  // Thin stays at 68 KiB. The app-grant entry itself loads lazily.
  { name: "sdk", entry: "src/index.ts", ceiling: 176 * KiB, forbidden: ["ajv", "ajv-formats"] },
];

let failed = false;
for (const { name, entry, ceiling, forbidden: forbiddenPackages } of entries) {
  // Split like an app's bundler does: what loads with the entry (its chunk and
  // the chunks it imports statically) is measured against the ceiling; a lazy
  // `import()` (Private collections load the app-grant entry on first use) is
  // reported beside it and still may not carry a forbidden dependency.
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
    outdir: "size-out",
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
  const files = new Map(r.outputFiles.map((file) => [file.path.slice(file.path.lastIndexOf("size-out/")), file.contents]));
  // Chunks gzipped together, as the unsplit bundle was, so figures stay comparable.
  const measure = (paths) => {
    const contents = Buffer.concat(paths.map((path) => files.get(path.slice(path.lastIndexOf("size-out/")))));
    return { raw: contents.length, gz: gzipSync(contents, { level: 9 }).length };
  };
  const { raw, gz } = measure([...initial]);
  console.log(`${name} bundle: ${(raw / KiB).toFixed(1)} KiB raw, ${(gz / KiB).toFixed(1)} KiB gzip (ceiling ${ceiling / KiB} KiB)`);
  const lazy = Object.keys(outputs).filter((path) => !initial.has(path) && path.endsWith(".js"));
  if (lazy.length) {
    const later = measure(lazy);
    console.log(`${name} lazy chunks: ${(later.raw / KiB).toFixed(1)} KiB raw, ${(later.gz / KiB).toFixed(1)} KiB gzip (no ceiling)`);
  }
  if (gz > ceiling) {
    console.error(`${name} bundle over its size ceiling`);
    failed = true;
  }
}

// Informational: the account-key surface (`@mdbase-dev/sdk/account`) is loaded only by
// apps that set up or unlock private collections; it has no ceiling of its own.
const a = await build({ entryPoints: ["src/account.ts"], bundle: true, minify: true, format: "esm", platform: "browser", write: false, treeShaking: true });
const araw = a.outputFiles[0].contents;
console.log(`account bundle: ${(araw.length / KiB).toFixed(1)} KiB raw, ${(gzipSync(araw, { level: 9 }).length / KiB).toFixed(1)} KiB gzip (no ceiling)`);
if (failed) process.exit(1);
