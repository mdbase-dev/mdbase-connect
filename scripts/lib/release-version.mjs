import { readFile } from "node:fs/promises";
import path from "node:path";

// The workspace cohort that version:check keeps on one source version, not every
// workspace: the editor and feedback service have independent versions. Release
// versions are allocated by continuous release and stamped at publication.
export const packagePaths = [
  "package.json",
  "apps/desktop/package.json",
  "apps/portal/package.json",
  "packages/app-ui/package.json",
  "packages/client/package.json",
  "packages/devkit/package.json",
  "packages/i18n/package.json",
  "packages/management/package.json",
  "packages/protocol/package.json",
  "packages/sync/package.json",
  "packages/testing/package.json",
  "packages/ui/package.json",
  "packages/webhooks/package.json",
  "runtime/packages/sdk/package.json",
  "services/mcp/package.json",
  "services/server/package.json"
];
export const lockPaths = ["Cargo.lock", "deploy/docker/Cargo.lock.hosted-provider"];
// npm lock and the local Obsidian consumer carry the same SDK version.
export const sdkVersionFields = [
  ["runtime/packages/sdk/package-lock.json", ["version"]],
  ["runtime/packages/sdk/package-lock.json", ["packages", "", "version"]],
  ["runtime/packages/obsidian-runtime/package.json", ["peerDependencies", "@mdbase-dev/sdk"]],
  ["runtime/packages/obsidian-runtime/package-lock.json", ["packages", "", "peerDependencies", "@mdbase-dev/sdk"]],
  ["runtime/packages/obsidian-runtime/package-lock.json", ["packages", "../sdk", "version"]]
];

export async function versionedCrateNames(root, cargoManifest) {
  const memberBlock = cargoManifest.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1];
  if (!memberBlock) throw new Error("Cargo.toml has no explicit workspace members.");
  const names = new Set();
  for (const [, member] of memberBlock.matchAll(/"([^"]+)"/g)) {
    const manifest = await readFile(path.join(root, member, "Cargo.toml"), "utf8");
    if (/^version\.workspace\s*=\s*true\s*$/m.test(manifest)) {
      const name = manifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
      if (!name) throw new Error(`${member}/Cargo.toml has no package name.`);
      names.add(name);
    }
  }
  return names;
}
