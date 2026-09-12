import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  deployLocalLab,
  parseBuildxDigest,
  parseDeployArgs,
  parseRollbackArgs,
  requireConfirmation,
  requireGhcrAuthentication,
  resolveCloudOpsCommand
} from "./deploy-lab-local.mjs";

const root = "/private/worktrees/mdbase-connect";
const opsRoot = "/private/mdbase-cloud-ops";
const opsCommand = `${opsRoot}/bin/deploy-local-lab`;
const head = "0123456789abcdef0123456789abcdef01234567";
const digestValues = {
  "deploy/docker/Dockerfile.server": `sha256:${"1".repeat(64)}`,
  "deploy/docker/Dockerfile.hosted-provider": `sha256:${"2".repeat(64)}`,
  "deploy/docker/Dockerfile.mcp": `sha256:${"3".repeat(64)}`
};
const checkout = resolve(import.meta.dirname, "..");

function harness({ status = "?? local-change\n", buildFailure = null, malformedMetadata = false } = {}) {
  const calls = [];
  const metadataPaths = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git" && args[0] === "rev-parse") return `${head}\n`;
    if (command === "git" && args[0] === "status") return status;
    if (command === "docker" && args[0] === "buildx" && args[1] === "build") {
      const dockerfile = args[args.indexOf("--file") + 1];
      const metadataPath = args[args.indexOf("--metadata-file") + 1];
      metadataPaths.push(metadataPath);
      assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
      assert.equal((await stat(resolve(metadataPath, ".."))).mode & 0o777, 0o700);
      if (buildFailure === dockerfile) throw new Error("fake build failed");
      await writeFile(metadataPath, malformedMetadata
        ? "{}\n"
        : `${JSON.stringify({ "containerimage.digest": digestValues[dockerfile] })}\n`);
    }
    return "";
  };
  return { calls, metadataPaths, run };
}

const environment = Object.freeze({
  HOME: "/private/home",
  PATH: process.env.PATH
});
const resolveOpsCommand = async () => opsCommand;

test("confirmation is either an exact interactive LAB response or exact --confirm LAB", async () => {
  let prompts = 0;
  await requireConfirmation([], async () => {
    prompts += 1;
    return "LAB";
  });
  assert.equal(prompts, 1);
  await requireConfirmation(["--confirm", "LAB"], async () => {
    throw new Error("must not prompt");
  });
  for (const args of [["--confirm", "lab"], ["--confirm"], ["LAB"], ["--confirm", "LAB", "extra"]]) {
    await assert.rejects(requireConfirmation(args), /Usage/u);
  }
  for (const answer of ["lab", " LAB", "LAB ", ""] ) {
    await assert.rejects(requireConfirmation([], async () => answer), /exactly match/u);
  }
});

test("component selection accepts only one exact supported component and remains separate from confirmation", () => {
  for (const component of ["connect", "hosted-provider", "mcp", "editor"]) {
    assert.deepEqual(parseDeployArgs(["--component", component, "--confirm", "LAB"]), {
      component,
      confirmationArgs: ["--confirm", "LAB"]
    });
    assert.deepEqual(parseDeployArgs(["--confirm", "LAB", "--component", component]), {
      component,
      confirmationArgs: ["--confirm", "LAB"]
    });
  }
  assert.deepEqual(parseDeployArgs(["--confirm", "LAB"]), {
    component: null,
    confirmationArgs: ["--confirm", "LAB"]
  });
  for (const args of [
    ["--component"],
    ["--component", "all"],
    ["--component", "CONNECT"],
    ["--component", "connect", "--component", "mcp"]
  ]) assert.throws(() => parseDeployArgs(args), /component|Usage/u);
});

test("default ops discovery derives and validates the canonical sibling checkout", async () => {
  const projects = await mkdtemp(resolve(tmpdir(), "mdbase-local-ops-"));
  const connectRoot = resolve(projects, "mdbase-connect");
  const common = resolve(connectRoot, ".git");
  const ops = resolve(projects, "mdbase-cloud-ops");
  const command = resolve(ops, "bin/deploy-local-lab");
  await mkdir(common, { recursive: true });
  await mkdir(resolve(ops, "bin"), { recursive: true });
  await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const run = async (_command, args, options) => {
      if (args.includes("--git-common-dir")) return `${common}\n`;
      if (args.includes("--show-toplevel")) { assert.equal(options.cwd, ops); return `${ops}\n`; }
      if (args[0] === "remote") return "https://github.com/mdbase-dev/mdbase-cloud-ops.git\n";
      throw new Error(`unexpected discovery command: ${args.join(" ")}`);
    };
    assert.equal(await resolveCloudOpsCommand({ root: connectRoot, run, environment: {} }), command);
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});

test("an explicit canonical ops worktree is validated without falling back to the sibling checkout", async () => {
  const projects = await mkdtemp(resolve(tmpdir(), "mdbase-explicit-ops-"));
  const connectRoot = resolve(projects, "mdbase-connect");
  const ops = resolve(projects, "ops-worktree");
  const command = resolve(ops, "bin/deploy-local-lab");
  await mkdir(connectRoot, { recursive: true });
  await mkdir(resolve(ops, "bin"), { recursive: true });
  await writeFile(command, "#!/bin/sh\n", { mode: 0o700 });
  await chmod(command, 0o700);
  try {
    const run = async (_command, args, options) => {
      assert(!args.includes("--git-common-dir"));
      if (args.includes("--show-toplevel")) { assert.equal(options.cwd, ops); return `${ops}\n`; }
      if (args[0] === "remote") return "https://github.com/mdbase-dev/mdbase-cloud-ops.git\n";
      throw new Error(`unexpected explicit discovery command: ${args.join(" ")}`);
    };
    assert.equal(await resolveCloudOpsCommand({
      root: connectRoot,
      run,
      environment: { MDBASE_CLOUD_OPS_CHECKOUT: ops }
    }), command);
    await assert.rejects(resolveCloudOpsCommand({
      root: connectRoot,
      run,
      environment: { MDBASE_CLOUD_OPS_CHECKOUT: "relative/ops" }
    }), /absolute path/u);
  } finally {
    await rm(projects, { recursive: true, force: true });
  }
});

test("rollback delegates directly to the fixed local LAB command", async () => {
  const calls = [];
  const state = "/private/state.json";
  assert.equal(parseRollbackArgs(["--rollback", state, "--confirm", "LAB"]), state);
  for (const args of [["--rollback"], ["--rollback", state], ["--rollback", state, "--confirm", "lab"], ["--rollback", state, "--confirm", "LAB", "--component", "connect"]]) {
    assert.throws(() => parseRollbackArgs(args), /Usage/u);
  }
  await deployLocalLab(environment, ["--rollback", state, "--confirm", "LAB"], {
    root,
    resolveOpsCommand,
    run: async (command, args, options) => { calls.push({ command, args, options }); return ""; },
    confirm: async () => { throw new Error("rollback must not prompt after exact confirmation"); }
  });
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    [opsCommand, "rollback", "--confirm", "LAB", state]
  ]);
});

test("dirty local checkout builds and pushes three amd64 images and deploys immutable matching digests", async () => {
  const fixture = harness();
  let authenticationChecks = 0;
  await deployLocalLab(environment, ["--confirm", "LAB"], {
    root,
    run: fixture.run,
    checkAuthentication: async () => { authenticationChecks += 1; },
    resolveOpsCommand,
    now: () => 1770000000000,
    random: () => "cafebabe"
  });

  assert.equal(authenticationChecks, 1);
  assert.equal(fixture.calls.findIndex(({ command, args }) => command === opsCommand && args[0] === "preflight")
    < fixture.calls.findIndex(({ command, args }) => command === "docker" && args[1] === "build"), true);
  const builds = fixture.calls.filter(({ command, args }) => command === "docker" && args[0] === "buildx" && args[1] === "build");
  assert.equal(builds.length, 3);
  const expectedRepositories = [
    "ghcr.io/mdbase-dev/mdbase-connect-server",
    "ghcr.io/mdbase-dev/mdbase-connect-hosted-provider",
    "ghcr.io/mdbase-dev/mdbase-connect-mcp"
  ];
  for (const [index, { args, options }] of builds.entries()) {
    assert.equal(options.cwd, root);
    assert.deepEqual(args.slice(0, 2), ["buildx", "build"]);
    assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
    assert.ok(args.includes("--push"));
    assert.ok(args.includes("--provenance=false"));
    assert.equal(args[args.indexOf("--build-arg") + 1], `MDBASE_CONNECT_REVISION=${head}`);
    assert.equal(args[args.indexOf("--tag") + 1], `${expectedRepositories[index]}:lab-local-0123456789ab-1770000000000-cafebabe`);
  }

  const deploy = fixture.calls.find(({ command, args }) => command === opsCommand && args[0] === "deploy");
  assert.deepEqual(deploy.args, [
    "deploy",
    "--confirm", "LAB",
    "--connect", `${expectedRepositories[0]}@${digestValues["deploy/docker/Dockerfile.server"]}`,
    "--hosted-provider", `${expectedRepositories[1]}@${digestValues["deploy/docker/Dockerfile.hosted-provider"]}`,
    "--mcp", `${expectedRepositories[2]}@${digestValues["deploy/docker/Dockerfile.mcp"]}`,
    "--source-revision", head,
    "--source-dirty", "true",
    "--editor-checkout", root
  ]);
  assert.deepEqual(fixture.calls.map(({ command }) => command).filter((command) =>
    ["gh", "cosign"].includes(command) || command.includes("release") || command.includes("qualification")
  ), []);
  for (const path of fixture.metadataPaths) await assert.rejects(stat(path), /ENOENT/u);
});

test("local image revisions survive Render runtime metadata overrides", async () => {
  const [serverDockerfile, mcpDockerfile, serverEntry, mcpEntry] = await Promise.all([
    readFile(resolve(checkout, "deploy/docker/Dockerfile.server"), "utf8"),
    readFile(resolve(checkout, "deploy/docker/Dockerfile.mcp"), "utf8"),
    readFile(resolve(checkout, "services/server/src/index.ts"), "utf8"),
    readFile(resolve(checkout, "services/mcp/src/index.ts"), "utf8")
  ]);
  for (const dockerfile of [serverDockerfile, mcpDockerfile]) {
    assert.match(dockerfile, /MDBASE_CONNECT_REVISION=\$\{MDBASE_CONNECT_REVISION\}/u);
  }
  for (const entry of [serverEntry, mcpEntry]) {
    assert.match(entry, /process\.env\.MDBASE_CONNECT_REVISION \?\? process\.env\.RENDER_GIT_COMMIT/u);
  }
});

test("component deployments build and delegate only the selected resource", async (context) => {
  const cases = [
    {
      component: "connect",
      dockerfile: "deploy/docker/Dockerfile.server",
      deployArgs: ["--connect", `ghcr.io/mdbase-dev/mdbase-connect-server@${digestValues["deploy/docker/Dockerfile.server"]}`]
    },
    {
      component: "hosted-provider",
      dockerfile: "deploy/docker/Dockerfile.hosted-provider",
      deployArgs: ["--hosted-provider", `ghcr.io/mdbase-dev/mdbase-connect-hosted-provider@${digestValues["deploy/docker/Dockerfile.hosted-provider"]}`]
    },
    {
      component: "mcp",
      dockerfile: "deploy/docker/Dockerfile.mcp",
      deployArgs: ["--mcp", `ghcr.io/mdbase-dev/mdbase-connect-mcp@${digestValues["deploy/docker/Dockerfile.mcp"]}`]
    },
    { component: "editor", dockerfile: null, deployArgs: [] }
  ];
  for (const scenario of cases) await context.test(scenario.component, async () => {
    const fixture = harness();
    let authenticationChecks = 0;
    await deployLocalLab(environment, ["--component", scenario.component, "--confirm", "LAB"], {
      root,
      run: fixture.run,
      checkAuthentication: async () => { authenticationChecks += 1; },
      resolveOpsCommand,
      now: () => 1770000000000,
      random: () => "cafebabe"
    });
    const commandCalls = fixture.calls.map(({ command, args }) => [command, ...args]);
    assert.deepEqual(commandCalls.find(([command, subcommand]) => command === opsCommand && subcommand === "preflight"),
      [opsCommand, "preflight", "--component", scenario.component]);
    const builds = fixture.calls.filter(({ command, args }) => command === "docker" && args[0] === "buildx" && args[1] === "build");
    assert.equal(builds.length, scenario.dockerfile ? 1 : 0);
    assert.equal(authenticationChecks, scenario.dockerfile ? 1 : 0);
    if (scenario.dockerfile) assert.equal(builds[0].args[builds[0].args.indexOf("--file") + 1], scenario.dockerfile);
    assert.deepEqual(commandCalls.find(([command, subcommand]) => command === opsCommand && subcommand === "deploy"), [
      opsCommand,
      "deploy",
      "--component", scenario.component,
      "--confirm", "LAB",
      ...scenario.deployArgs,
      "--source-revision", head,
      "--source-dirty", "true",
      ...(scenario.component === "editor" ? ["--editor-checkout", root] : [])
    ]);
    if (scenario.component === "editor") {
      assert.equal(fixture.calls.some(({ command }) => command === "docker"), false);
    }
  });
});

test("invalid component forms fail before preflight, Docker, or authentication", async () => {
  for (const args of [
    ["--component", "all", "--confirm", "LAB"],
    ["--component", "connect", "--component", "mcp", "--confirm", "LAB"],
    ["--component", "connect", "--confirm", "lab"]
  ]) {
    const calls = [];
    let authenticationChecks = 0;
    await assert.rejects(deployLocalLab(environment, args, {
      root,
      run: async (command, commandArgs) => { calls.push([command, ...commandArgs]); return ""; },
      checkAuthentication: async () => { authenticationChecks += 1; },
      resolveOpsCommand
    }), /component|Usage/u);
    assert.deepEqual(calls, []);
    assert.equal(authenticationChecks, 0);
  }
});

test("clean status is informationally passed as false", async () => {
  const fixture = harness({ status: "" });
  await deployLocalLab(environment, ["--confirm", "LAB"], {
    root,
    run: fixture.run,
    checkAuthentication: async () => undefined,
    resolveOpsCommand,
    now: () => 1,
    random: () => "abcd"
  });
  const deploy = fixture.calls.find(({ command, args }) => command === opsCommand && args[0] === "deploy");
  assert.equal(deploy.args[deploy.args.indexOf("--source-dirty") + 1], "false");
});

test("preflight, authentication, build, and metadata failures stop deployment and clean metadata", async () => {
  for (const scenario of ["preflight", "authentication", "build", "metadata"]) {
    const fixture = harness({
      buildFailure: scenario === "build" ? "deploy/docker/Dockerfile.hosted-provider" : null,
      malformedMetadata: scenario === "metadata"
    });
    const run = async (...input) => {
      if (scenario === "preflight" && input[0] === opsCommand && input[1][0] === "preflight") {
        fixture.calls.push({ command: input[0], args: input[1], options: input[2] });
        throw new Error("fake preflight failed");
      }
      return fixture.run(...input);
    };
    await assert.rejects(deployLocalLab(environment, ["--confirm", "LAB"], {
      root,
      run,
      checkAuthentication: async () => {
        if (scenario === "authentication") throw new Error("no GHCR auth");
      },
      resolveOpsCommand,
      now: () => 1,
      random: () => "abcd"
    }), /fake|auth|metadata/u);
    assert.equal(fixture.calls.some(({ command, args }) => command === opsCommand && args[0] === "deploy"), false);
    if (scenario === "preflight" || scenario === "authentication") {
      assert.equal(fixture.calls.some(({ command, args }) => command === "docker" && args[1] === "build"), false);
    }
    for (const path of fixture.metadataPaths) await assert.rejects(stat(path), /ENOENT/u);
  }
});

test("invalid HEAD fails before preflight or builds", async () => {
  const calls = [];
  await assert.rejects(deployLocalLab(environment, ["--confirm", "LAB"], {
    root,
    run: async (command, args) => {
      calls.push({ command, args });
      return "short-head\n";
    },
    checkAuthentication: async () => undefined,
    resolveOpsCommand
  }), /40-hex/u);
  assert.deepEqual(calls.map(({ command }) => command), ["git"]);
});

test("GHCR authentication guard requires an existing Docker registry entry", async () => {
  await requireGhcrAuthentication({
    DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { "ghcr.io": {} } })
  });
  await requireGhcrAuthentication({
    DOCKER_AUTH_CONFIG: JSON.stringify({ credHelpers: { "https://ghcr.io/v1/": "secretservice" } })
  });
  await requireGhcrAuthentication({
    DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { "docker.io": {} }, credsStore: "secretservice" })
  });
  await assert.rejects(requireGhcrAuthentication({
    DOCKER_AUTH_CONFIG: JSON.stringify({ auths: { "docker.io": {} } })
  }), /ghcr\.io/u);
  await assert.rejects(requireGhcrAuthentication({ DOCKER_AUTH_CONFIG: "not-json" }), /valid JSON/u);
});

test("Buildx digest parser accepts only immutable sha256 metadata", () => {
  assert.equal(parseBuildxDigest(JSON.stringify({ "containerimage.digest": `sha256:${"a".repeat(64)}` }), "connect"), `sha256:${"a".repeat(64)}`);
  for (const source of ["not-json", "{}", JSON.stringify({ "containerimage.digest": "sha256:short" }), JSON.stringify({ "containerimage.digest": `${"a".repeat(64)}` })]) {
    assert.throws(() => parseBuildxDigest(source, "connect"), /metadata/u);
  }
});
