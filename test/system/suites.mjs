export const systemSuites = Object.freeze({
  local: {
    description: "Local connector, control plane, browser, and grant lifecycle",
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
  container: {
    description: "Packaged control plane with PostgreSQL and NATS",
    prepare: [],
    command: ["node", "scripts/container-e2e.mjs"]
  },
  desktop: {
    description: "Native Electron client against the packaged environment",
    prepare: ["desktop", "cli-binary"],
    command: ["node", "apps/desktop/scripts/docker-server-e2e.mjs"],
    headless: true
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
  desktop: [
    "pnpm", "--filter", "@mdbase/connect-desktop", "build:standalone"
  ],
  "cli-binary": ["cargo", "build", "-p", "mdbase-cli"]
});
