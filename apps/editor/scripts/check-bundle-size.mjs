import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadBundleAssets } from "./bundle-assets.mjs";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "dist/index.html"), "utf8");
const initialScripts = await loadBundleAssets(root, assetPaths(html, /<(?:script|link)[^>]+(?:src|href)="([^"]+\.(?:m?js)(?:[?#][^"]*)?)"/g));
const styles = await loadBundleAssets(root, assetPaths(html, /<link[^>]+href="([^"]+\.css(?:[?#][^"]*)?)"/g));
if (initialScripts.length === 0 || styles.length === 0) {
  throw new Error("The built application did not expose its initial JavaScript and CSS assets.");
}

// Standalone apps are not size-gated: initial JavaScript is measured and
// reported, never failed. The CSS budget still applies.
const limits = {
  // Includes @mdbase-dev/ui's tokens, controls, brand, screens and mark motion, shared with Reader and Writer.
  initialCss: 42 * 1024
};

const initialJavaScript = compressedBytes(initialScripts);
const initialCss = compressedBytes(styles);

assertWithin("initial CSS", initialCss, limits.initialCss);

const categories = ["bundle", "public", "generated"].map(kind => `${format(compressedBytes(initialScripts.filter(asset => asset.kind === kind)))} ${kind}`).join(", ");
console.log(`Bundle report: ${format(initialJavaScript)} initial JavaScript (${categories}; not gated), ${format(initialCss)} initial CSS (budget passed).`);

function compressedBytes(files) {
  return files.reduce((total, { content }) => total + gzipSync(content).byteLength, 0);
}

function assetPaths(source, pattern) {
  return [...source.matchAll(pattern)].map(match => match[1]);
}

function assertWithin(label, actual, maximum) {
  if (actual > maximum) {
    throw new Error(`${label} is ${format(actual)} gzip; the budget is ${format(maximum)}.`);
  }
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
