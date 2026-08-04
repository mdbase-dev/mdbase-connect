import { pathToFileURL } from "node:url";

import { publicPackages } from "./public-packages.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export async function findUnbootstrappedPackages({
  fetchImpl = globalThis.fetch,
  registry = process.env.npm_config_registry ?? DEFAULT_REGISTRY,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const packages = await publicPackages();
  const results = await Promise.all(
    packages.map(async ({ name }) => {
      const response = await fetchImpl(packageMetadataUrl(registry, name), {
        headers: { accept: "application/json" },
      });
      if (response.ok) return undefined;
      if (response.status === 404) return name;
      throw new Error(
        `npm registry lookup for ${name} returned HTTP ${response.status}`,
      );
    }),
  );
  return results.filter(Boolean);
}

export function packageMetadataUrl(registry, packageName) {
  const registryUrl = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  return new URL(encodeURIComponent(packageName), registryUrl).href;
}

async function main() {
  const missing = await findUnbootstrappedPackages();
  if (missing.length === 0) {
    process.stdout.write("Every public npm package is bootstrapped.\n");
    return;
  }

  process.stderr.write(
    [
      "::error::Public npm packages must exist before trusted publishing can release them.",
      ...missing.map((name) => `- ${name}`),
      "Publish each package once with an interactive scope-owner session, configure publish-npm.yml as its trusted publisher, and rerun this check before creating a release tag.",
      "See docs/releasing.md for the exact bootstrap procedure.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
