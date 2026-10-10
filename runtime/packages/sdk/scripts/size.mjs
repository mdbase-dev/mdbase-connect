// Size of the thin-client bundle (everything a web app needs: codec, client, Noise,
// relay transport, keys), minified and gzipped. replica-client-api.md §12.3 expects
// "a few tens of KiB"; CI fails above the ceiling.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";

const CEILING_GZIP = 64 * 1024;
const r = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  write: false,
  treeShaking: true,
});
const raw = r.outputFiles[0].contents;
const gz = gzipSync(raw, { level: 9 }).length;
console.log(`sdk bundle: ${(raw.length / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzip (ceiling ${CEILING_GZIP / 1024} KiB)`);
if (gz > CEILING_GZIP) {
  console.error("sdk bundle over its size ceiling");
  process.exit(1);
}

// Informational: the account-key surface (`@mdbase-dev/sdk/account`) is loaded only by
// apps that set up or unlock private collections; it has no ceiling of its own.
const a = await build({ entryPoints: ["src/account.ts"], bundle: true, minify: true, format: "esm", platform: "browser", write: false, treeShaking: true });
const araw = a.outputFiles[0].contents;
console.log(`account bundle: ${(araw.length / 1024).toFixed(1)} KiB raw, ${(gzipSync(araw, { level: 9 }).length / 1024).toFixed(1)} KiB gzip (no ceiling)`);
