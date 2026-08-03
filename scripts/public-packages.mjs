import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packagesRoot = resolve(root, "packages");

// Dependency order matters when a release is only partly complete and retried.
export const publicPackageDirectories = [
  "packages/protocol",
  "packages/client",
  "packages/devkit",
  "packages/sync",
  "packages/testing",
  "packages/pickle",
  "packages/webhooks"
];

export async function publicPackages() {
  const packages = await Promise.all(publicPackageDirectories.map(async (directory) => {
    const manifest = JSON.parse(await readFile(resolve(root, directory, "package.json"), "utf8"));
    if (manifest.private === true || typeof manifest.name !== "string") {
      throw new Error(`${directory} is not a publishable package`);
    }
    return { directory, name: manifest.name };
  }));

  const discovered = [];
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(await readFile(resolve(packagesRoot, entry.name, "package.json"), "utf8"));
    if (manifest.private !== true) discovered.push(`packages/${entry.name}`);
  }
  const listed = [...publicPackageDirectories].sort();
  discovered.sort();
  if (JSON.stringify(discovered) !== JSON.stringify(listed)) {
    throw new Error(`Public package release list is incomplete: expected ${discovered.join(", ")}; found ${listed.join(", ")}`);
  }

  return packages;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const item of await publicPackages()) process.stdout.write(`${item.name}\t${item.directory}\n`);
}
