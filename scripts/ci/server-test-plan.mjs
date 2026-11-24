import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { systemSuites } from "../../test/system/suites.mjs";

// Pull requests run a fast lane (classify, node, and only the suites the diff
// touches) unless labeled `ci:full`. Merge-queue commits always run full
// qualification, so an input missing here delays feedback but never skips a
// release gate.
export const systemSuiteShards = Object.freeze([
  Object.freeze({ shard: "relay", suites: "relay", timeout: 55 }),
  Object.freeze({ shard: "linux-packages", suites: "linux-packages", timeout: 35 })
]);

const allSuiteFiles = [
  ".github/workflows/server-ci.yml",
  "scripts/ci/server-test-plan.mjs"
];

const suiteMatchers = {
  container: {
    files: new Set([
      ...allSuiteFiles,
      systemSuites.container.command[1],
      "scripts/lib/connect-test-environment.mjs"
    ]),
    prefixes: [
      "deploy/docker/",
      "test/system/"
    ]
  },
  log_postgres: {
    files: new Set([
      ...allSuiteFiles,
      "runtime/Cargo.toml",
      "runtime/Cargo.lock",
      "runtime/rust-toolchain.toml"
    ]),
    prefixes: [
      "runtime/crates/log-",
      "runtime/crates/wire/",
      ".cargo/",
      "rust-toolchain"
    ]
  },
  log_do: {
    files: new Set([
      ...allSuiteFiles,
      "runtime/Cargo.toml",
      "runtime/Cargo.lock",
      "runtime/rust-toolchain.toml",
      "scripts/ci/prefetch-worker-tools.mjs",
      "scripts/lib/github-release-download.mjs"
    ]),
    prefixes: [
      "runtime/crates/log-",
      "runtime/crates/wire/",
      "runtime/deploy/cloudflare-do/",
      ".cargo/",
      "rust-toolchain"
    ]
  },
  relay: {
    files: new Set([
      ...allSuiteFiles,
      systemSuites.relay.command[1],
      "scripts/system/relay-approval.mjs",
      "scripts/lib/relay-crypto.mjs",
      "deploy/docker/Dockerfile.nats"
    ]),
    prefixes: [
      "test/system/",
      "services/server/src/features/relay/"
    ]
  },
  linux_packages: {
    files: new Set([
      ...allSuiteFiles,
      systemSuites["linux-packages"].command[1]
    ]),
    prefixes: [
      "apps/desktop/test/linux-packages/",
      "test/system/"
    ]
  }
};

function matchesSuite(paths, matcher) {
  return paths.some((path) => matcher.files.has(path)
    || matcher.prefixes.some((prefix) => path.startsWith(prefix)));
}

export function selectedSystemSuites(plan) {
  return systemSuiteShards.filter(({ shard }) => {
    if (shard === "relay") return Boolean(plan.relay);
    if (shard === "linux-packages") return Boolean(plan.linux_packages);
    return true;
  });
}

export function fullServerTestPlan() {
  return {
    container: true,
    log_postgres: true,
    log_do: true,
    relay: true,
    linux_packages: true,
    native: true
  };
}

export function serverTestPlan(paths) {
  const container = matchesSuite(paths, suiteMatchers.container);
  const log_postgres = matchesSuite(paths, suiteMatchers.log_postgres);
  const log_do = matchesSuite(paths, suiteMatchers.log_do);
  const relay = matchesSuite(paths, suiteMatchers.relay);
  const linux_packages = matchesSuite(paths, suiteMatchers.linux_packages);
  return {
    container,
    log_postgres,
    log_do,
    relay,
    linux_packages,
    native: container || log_postgres || log_do || relay || linux_packages
  };
}

function formatOutputs(plan, fallbackFull = false) {
  const suites = selectedSystemSuites(plan);
  return {
    ...plan,
    fallback_full: fallbackFull,
    has_system_suites: suites.length > 0,
    system_suites_matrix: JSON.stringify({ include: suites })
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [first, second] = process.argv.slice(2);
  let plan;
  let paths = [];
  let fallbackFull = false;
  if (first === "--full") {
    plan = fullServerTestPlan();
  } else if (!first || !second) {
    console.error("server-test-plan: missing base or head revision; falling back to full qualification");
    plan = fullServerTestPlan();
    fallbackFull = true;
  } else {
    try {
      // --no-renames includes both sides of moves so suite inputs cannot disappear.
      paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${first}...${second}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).split("\0").filter(Boolean);
      plan = serverTestPlan(paths);
    } catch (error) {
      console.error(`server-test-plan: git diff failed (${error.message}); falling back to full qualification`);
      plan = fullServerTestPlan();
      fallbackFull = true;
    }
  }
  const outputs = formatOutputs(plan, fallbackFull);
  console.log(JSON.stringify({ paths, fallback_full: fallbackFull, ...plan, system_suites: selectedSystemSuites(plan) }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}
