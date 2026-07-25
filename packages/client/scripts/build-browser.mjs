import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "dist/browser");
const outputFile = resolve(outputDirectory, "mdbase-connect.min.js");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/index.ts")],
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
const integrity = `sha384-${createHash("sha384").update(bundle).digest("base64")}`;
await writeFile(
  resolve(outputDirectory, "integrity.json"),
  `${JSON.stringify({ file: "mdbase-connect.min.js", integrity }, null, 2)}\n`
);
await writeFile(
  resolve(outputDirectory, "mdbase-connect.min.js.sha384"),
  `${integrity}\n`
);
