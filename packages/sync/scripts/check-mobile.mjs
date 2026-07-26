#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const result = await build({
  entryPoints: ["src/mirror.ts"],
  absWorkingDir: packageRoot,
  bundle: true,
  format: "esm",
  minify: true,
  platform: "browser",
  target: ["es2022"],
  treeShaking: true,
  define: {
    Buffer: "__MDBASE_FORBIDDEN_BUFFER__",
    process: "__MDBASE_FORBIDDEN_PROCESS__"
  },
  write: false,
  metafile: true,
  logLevel: "silent"
});

const output = result.outputFiles[0];
if (!output) throw new Error("Mobile mirror bundle was not produced.");
const source = output.text;
const nodeImports = source.match(
  /(?:(?:from|import)\s*["']node:|require\s*\(|__MDBASE_FORBIDDEN_(?:BUFFER|PROCESS)__)/g
) ?? [];
if (nodeImports.length > 0) {
  throw new Error(`Mobile mirror bundle contains Node-only references: ${[...new Set(nodeImports)].join(", ")}`);
}

const rawBytes = output.contents.byteLength;
const gzipBytes = gzipSync(output.contents).byteLength;
const budgets = {
  raw_bytes: 175_000,
  gzip_bytes: 55_000
};
if (rawBytes > budgets.raw_bytes || gzipBytes > budgets.gzip_bytes) {
  throw new Error(
    `Mobile mirror bundle exceeds its budget: ${rawBytes} raw / ${gzipBytes} gzip bytes.`
  );
}

process.stdout.write(`${JSON.stringify({
  mobile_safe: true,
  raw_bytes: rawBytes,
  gzip_bytes: gzipBytes,
  budgets,
  bundled_modules: Object.keys(result.metafile.inputs).length
}, null, 2)}\n`);
