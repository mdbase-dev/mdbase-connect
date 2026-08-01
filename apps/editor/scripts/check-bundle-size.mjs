import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const html = await readFile(resolve(root, "dist/index.html"), "utf8");
const initialScripts = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="\.\/([^"]+\.js)"/g)]
  .map((match) => match[1]);
const styles = [...html.matchAll(/<link[^>]+href="\.\/([^"]+\.css)"/g)]
  .map((match) => match[1]);

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

function assertWithin(label, actual, maximum) {
  if (actual > maximum) {
    throw new Error(`${label} is ${format(actual)} gzip; the budget is ${format(maximum)}.`);
  }
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
