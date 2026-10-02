import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const editorRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(editorRoot, "../..");
const tokenFile = resolve(workspaceRoot, "packages/app-ui/css/tokens.css");

// Mask comments and strings, retaining line positions. No dependency or CSS rewrite needed.
export function checkStyleTokens(css, filename) {
  const source = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (value) => value.replace(/[^\n]/g, " "));
  const errors = [];
  const declarations = /(?:^|[;{}])\s*((?:--[\w-]*font-size)|font-size|font|border(?:-(?:top|bottom)-(?:left|right))?-radius|box-shadow)\s*:\s*([^;{}]*)/g;
  for (const match of source.matchAll(declarations)) {
    const [, property, value] = match;
    const rawPixels = /(?:\d*\.)?\d+px\b/i.test(value);
    const rawShadow = property === "box-shadow" && !/^(?:var\(--[\w-]+\)|none|inherit|initial|unset|revert(?:-layer)?)(?:\s*!important)?\s*$/.test(value.trim());
    if (rawPixels || rawShadow) {
      const line = source.slice(0, match.index).split("\n").length;
      errors.push(`${filename}:${line}: ${property} must use shared tokens (${value.trim()}).`);
    }
  }
  return errors;
}

async function cssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith(".css") ? [path] : [];
  }));
  return nested.flat();
}

async function main() {
  const files = (await Promise.all([
    cssFiles(resolve(editorRoot, "src")),
    cssFiles(resolve(workspaceRoot, "packages/app-ui/css"))
  ])).flat().filter((file) => file !== tokenFile).sort();
  const errors = (await Promise.all(files.map(async (file) =>
    checkStyleTokens(await readFile(file, "utf8"), relative(workspaceRoot, file))
  ))).flat();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Style tokens passed: ${files.length} editor/shared stylesheets checked.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
