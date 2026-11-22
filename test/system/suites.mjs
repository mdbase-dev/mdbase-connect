export const systemSuites = Object.freeze({
  "runtime-daemon": {
    description: "Runtime daemon request path against a local control plane (pnpm e2e)",
    prepare: ["packages", "runtime-daemon"],
    command: ["node", "scripts/next-e2e.mjs"]
  },
  relay: {
    description: "PostgreSQL and NATS relay behavior and recovery",
    prepare: ["packages"],
    command: ["node", "scripts/relay-e2e.mjs"]
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
  "runtime-daemon": [
    "cargo", "build", "-p", "mdbn-daemon", "--bin", "mdbase", "--example", "loopback_daemon"
  ]
});

export const preparationDirectories = Object.freeze({
  "runtime-daemon": "runtime"
});

export const pulledBinaries = Object.freeze({
  "runtime-daemon": ["mdbase", "debug/examples/loopback_daemon"]
});
