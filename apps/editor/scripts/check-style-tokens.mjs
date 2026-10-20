import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Use one physical namespace for every URL/argv/root/CSS comparison. The
// native API also expands Windows 8.3 paths; Node URL resolution may retain them.
const canonicalPath = (path) => realpathSync.native(path);
const moduleFile = canonicalPath(fileURLToPath(import.meta.url));
const editorRoot = canonicalPath(resolve(dirname(moduleFile), ".."));
const workspaceRoot = canonicalPath(resolve(editorRoot, "../.."));

// Mask comments and strings, retaining line positions. No dependency or CSS rewrite needed.
export function checkStyleTokens(css, filename) {
  const source = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (value) => value.replace(/[^\n]/g, " "));
  const errors = [];
  for (const match of source.matchAll(/var\(\s*--[\w-]+\s*\(/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    errors.push(`${filename}:${line}: malformed custom-property reference (${match[0]}).`);
  }
  const declarations = /(?:^|[;{}])\s*((?:--[\w-]*font-size)|font-size|font|border(?:-(?:top|bottom)-(?:left|right))?-radius|box-shadow|text-transform)\s*:\s*([^;{}]*)/g;
  for (const match of source.matchAll(declarations)) {
    const [, property, value] = match;
    const rawPixels = /(?:\d*\.)?\d+px\b/i.test(value);
    const rawShadow = property === "box-shadow" && !/^(?:var\(--[\w-]+\)|none|inherit|initial|unset|revert(?:-layer)?)(?:\s*!important)?\s*$/.test(value.trim());
    const rawRadius = property.endsWith("radius") && !/^(?:(?:0|50%|inherit|initial|unset|revert(?:-layer)?)(?:\s+|$))*$/.test(
      value.replace(/var\(--[\w-]+\)|\s*!important/g, "").trim()
    );
    const forcedCase = property === "text-transform" && /\b(?:uppercase|capitalize)\b/.test(value);
    if (rawPixels || rawShadow || rawRadius || forcedCase) {
      const line = source.slice(0, match.index + match[0].indexOf(property)).split("\n").length;
      const requirement = forcedCase ? "must preserve sentence-case content" : "must use shared tokens";
      errors.push(`${filename}:${line}: ${property} ${requirement} (${value.trim()}).`);
    }
  }
  return errors;
}

async function cssFiles(directory) {
  const root = canonicalPath(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith(".css") ? [canonicalPath(path)] : [];
  }));
  return nested.flat();
}

async function main() {
  const tokenFile = canonicalPath(fileURLToPath(import.meta.resolve("@mdbase-dev/ui/tokens.css")));
  const files = (await Promise.all([
    cssFiles(resolve(editorRoot, "src")),
    cssFiles(dirname(tokenFile))
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

let entryFile;
try {
  if (process.argv[1]) entryFile = canonicalPath(process.argv[1]);
} catch {
  // A non-file entry (for example node -e) is an import, not this CLI.
}
if (entryFile === moduleFile) await main();
