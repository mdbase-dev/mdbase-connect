import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "dist/browser");
const outputFile = resolve(outputDirectory, "mdbase-connect.min.js");
const budget = JSON.parse(
  await readFile(resolve(root, "browser-bundle-budget.json"), "utf8")
);
// Keep the measured baseline reviewable in source control. Raise it only when a
// deliberate bundle increase has been accepted; warning and ceiling values are policy.

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/browser.ts")],
  outfile: outputFile,
  bundle: true,
  format: "iife",
  globalName: "MdbaseConnect",
  minify: true,
  target: ["es2022"],
  legalComments: "none",
  sourcemap: false,
  platform: "browser"
});

const bundle = await readFile(outputFile);
const gzipBytes = gzipSync(bundle).byteLength;
if (bundle.byteLength > budget.maximumRawBytes || gzipBytes > budget.maximumGzipBytes) {
  throw new Error(
    `Browser SDK exceeds its hard ceiling: ${bundle.byteLength}/${budget.maximumRawBytes} raw bytes, `
      + `${gzipBytes}/${budget.maximumGzipBytes} gzip bytes.`
  );
}
const warnings = [];
if (gzipBytes > budget.reviewGzipBytes) {
  warnings.push(
    `${gzipBytes} gzip bytes exceeds the ${budget.reviewGzipBytes}-byte review threshold`
  );
}
const regressionBytes = gzipBytes - budget.baselineGzipBytes;
if (regressionBytes > budget.regressionReviewBytes) {
  warnings.push(
    `${regressionBytes} gzip bytes above the checked-in baseline exceeds the `
      + `${budget.regressionReviewBytes}-byte per-change allowance`
  );
}
for (const warning of warnings) {
  const message = `Browser SDK bundle size: ${warning}.`;
  console.warn(
    process.env.GITHUB_ACTIONS === "true"
      ? `::warning title=Browser SDK bundle size::${message}`
      : message
  );
}
console.log(
  `Browser SDK bundle size: ${bundle.byteLength} raw bytes, ${gzipBytes} gzip bytes `
    + `(baseline ${budget.baselineGzipBytes}, hard ceiling ${budget.maximumGzipBytes}).`
);
const source = bundle.toString("utf8");
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) {
  throw new Error("Browser SDK violates the no-eval Content Security Policy contract.");
}
const integrity = `sha384-${createHash("sha384").update(bundle).digest("base64")}`;
await writeFile(
  resolve(outputDirectory, "integrity.json"),
  `${JSON.stringify({ file: "mdbase-connect.min.js", integrity }, null, 2)}\n`
);
await writeFile(
  resolve(outputDirectory, "mdbase-connect.min.js.sha384"),
  `${integrity}\n`
);
