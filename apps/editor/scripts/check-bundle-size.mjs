import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "dist/index.html"), "utf8");
const initialScripts = assetPaths(html, /<(?:script|link)[^>]+(?:src|href)="([^"]+\.js)"/g);
const styles = assetPaths(html, /<link[^>]+href="([^"]+\.css)"/g);
if (initialScripts.length === 0 || styles.length === 0) {
  throw new Error("The built application did not expose its initial JavaScript and CSS assets.");
}

const limits = {
  initialJavaScript: 200 * 1024,
  initialCss: 40 * 1024
};

const initialJavaScript = await compressedBytes(initialScripts);
const initialCss = await compressedBytes(styles);

assertWithin("initial JavaScript", initialJavaScript, limits.initialJavaScript);
assertWithin("initial CSS", initialCss, limits.initialCss);

console.log(`Bundle budgets passed: ${format(initialJavaScript)} initial JavaScript, ${format(initialCss)} initial CSS.`);

async function compressedBytes(files) {
  const contents = await Promise.all(files.map((file) => readFile(resolve(root, "dist", file))));
  return contents.reduce((total, content) => total + gzipSync(content).byteLength, 0);
}

function assetPaths(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => {
    const value = match[1];
    const marker = value.lastIndexOf("/assets/");
    if (marker >= 0) return value.slice(marker + 1);
    if (value.startsWith("assets/")) return value;
    throw new Error(`Built asset is outside the distribution asset directory: ${value}`);
  });
}

function assertWithin(label, actual, maximum) {
  if (actual > maximum) {
    throw new Error(`${label} is ${format(actual)} gzip; the budget is ${format(maximum)}.`);
  }
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
