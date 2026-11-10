export const systemSuites = Object.freeze({
  "runtime-daemon": {
    description: "Runtime daemon request path against a local control plane (pnpm e2e)",
    prepare: ["packages", "runtime-daemon"],
    command: ["node", "scripts/next-e2e.mjs"]
  },
  // Retire with the root connect-* crates (docs/legacy-retirement.md).
  "legacy-local": {
    description: "Legacy connector, control plane, browser, and grant lifecycle",
    prepare: ["packages", "rust-workspace"],
    command: ["node", "scripts/e2e.mjs"]
  },
  relay: {
    description: "PostgreSQL and NATS relay behavior and recovery",
    prepare: ["packages"],
    command: ["node", "scripts/relay-e2e.mjs"]
  },
  sync: {
    description: "Hosted synchronization vertical slice",
    prepare: ["packages"],
    command: ["node", "scripts/sync-e2e.mjs"]
  },
  provider: {
    description: "Durable hosted authority, browser, files, and provider lifecycle",
    prepare: ["packages", "provider-binaries"],
    command: ["node", "scripts/hosted-provider-e2e.mjs"]
  },
  files: {
    description: "Hosted file storage integration",
    prepare: ["packages", "provider-binary"],
    command: ["node", "scripts/hosted-files-e2e.mjs"]
  },
  "files-adversarial": {
    description: "Adversarial hosted-file regression suite",
    prepare: [],
    command: ["node", "scripts/hosted-file-adversarial-e2e.mjs"]
  },
  "projection-scale": {
    description: "Hosted projection 100k and 230k row fixtures",
    prepare: [],
    command: ["node", "scripts/hosted-projection-scale-e2e.mjs"]
  },
  container: {
    description: "Packaged control plane with PostgreSQL and NATS",
    prepare: [],
    command: ["node", "scripts/container-e2e.mjs"]
  },
  "linux-packages": {
    description: "RPM and DEB CLI entry-point installation, upgrade, and removal",
    prepare: [],
    command: ["node", "apps/desktop/test/linux-packages/run.mjs"]
  }
});

export const preparationSteps = Object.freeze({
  packages: ["pnpm", "build"],
  "rust-workspace": ["cargo", "build", "--workspace"],
  "provider-binaries": [
    "cargo", "build", "-p", "mdbase-connect-hosted-provider", "-p", "mdbase-cli"
  ],
  "provider-binary": [
    "cargo", "build", "-p", "mdbase-connect-hosted-provider"
  ],
  "cli-binary": ["cargo", "build", "-p", "mdbase-cli"],
  "runtime-daemon": [
    "cargo", "build", "-p", "mdbn-daemon", "--bin", "mdbase", "--example", "loopback_daemon"
  ]
});

// Steps that build another Cargo workspace run there; the rest at the root.
export const preparationDirectories = Object.freeze({
  "runtime-daemon": "runtime"
});

// What the suites run from target/debug, which rcargo copies back.
export const pulledBinaries = Object.freeze({
  "rust-workspace": ["mdbase"],
  "provider-binaries": ["mdbase-connect-hosted-provider", "mdbase"],
  "provider-binary": ["mdbase-connect-hosted-provider"],
  "cli-binary": ["mdbase"],
  "runtime-daemon": ["mdbase", "debug/examples/loopback_daemon"]
});
