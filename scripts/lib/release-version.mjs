// The workspace cohort that version:check keeps on one source version, not every
// workspace: the editor and feedback service have independent versions. Release
// versions are allocated by continuous release and stamped at publication.
export const packagePaths = [
  "package.json",
  "apps/desktop/package.json",
  "apps/portal/package.json",
  "packages/app-ui/package.json",
  "packages/i18n/package.json",
  "packages/management/package.json",
  "packages/protocol/package.json",
  "packages/ui/package.json",
  "packages/webhooks/package.json",
  "runtime/packages/sdk/package.json",
  "services/mcp/package.json",
  "services/server/package.json"
];
export const lockPaths = [];
// npm lock and the local Obsidian consumer carry the same SDK version.
export const sdkVersionFields = [
  ["runtime/packages/sdk/package-lock.json", ["version"]],
  ["runtime/packages/sdk/package-lock.json", ["packages", "", "version"]],
  ["runtime/packages/obsidian-runtime/package.json", ["peerDependencies", "@mdbase-dev/sdk"]],
  ["runtime/packages/obsidian-runtime/package-lock.json", ["packages", "", "peerDependencies", "@mdbase-dev/sdk"]],
  ["runtime/packages/obsidian-runtime/package-lock.json", ["packages", "../sdk", "version"]]
];
