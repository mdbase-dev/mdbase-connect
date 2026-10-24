import { build } from "esbuild";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const sdkDirectory = fileURLToPath(new URL("..", import.meta.url));

/** Build the same browser entry for classic scripts, without Node/testing surfaces. */
function packagedTrustPlugin() {
  return { name: "sdk-packaged-trust", setup(builder) {
    builder.onResolve({ filter: /^\.\/packaged-trust\.js$/ }, args => {
      if (args.resolveDir !== resolve(sdkDirectory, "src/application")) return;
      const path = resolve(sdkDirectory, "dist/application/packaged-trust.js");
      return existsSync(path) ? { path } : undefined;
    });
  }};
}

export async function buildBrowserBundles({ write = true } = {}) {
  const results = [];
  for (const minify of [false, true]) {
    results.push(await build({
      absWorkingDir: sdkDirectory,
      entryPoints: ["src/browser.ts"],
      outfile: `dist/browser/mdbase-sdk${minify ? ".min" : ""}.js`,
      bundle: true,
      platform: "browser",
      target: "es2022",
      format: "iife",
      globalName: "MdbaseSDK",
      minify,
      legalComments: "inline",
      metafile: true,
      plugins: [packagedTrustPlugin()],
      write,
    }));
  }
  return results;
}

/** The private SDK-owned Worker is an ESM artifact beside application/entry.js.
 * A source-only SDK without the signin Worker keeps its existing browser surfaces. */
export async function buildApplicationWorker({ write = true } = {}) {
  const entry = resolve(sdkDirectory, "src/application/worker.ts");
  if (!existsSync(entry)) return null;
  return build({ absWorkingDir: sdkDirectory, entryPoints: [entry],
    outfile: "dist/application/worker.js", bundle: true, platform: "browser",
    target: "es2022", format: "esm", plugins: [packagedTrustPlugin()],
    legalComments: "inline", metafile: true, write });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildBrowserBundles();
  await buildApplicationWorker();
}
