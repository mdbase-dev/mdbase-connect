#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const components = Object.freeze([
  Object.freeze({
    name: "connect",
    repository: "ghcr.io/mdbase-dev/mdbase-connect-server",
    dockerfile: "deploy/docker/Dockerfile.server"
  }),
  Object.freeze({
    name: "hosted-provider",
    repository: "ghcr.io/mdbase-dev/mdbase-connect-hosted-provider",
    dockerfile: "deploy/docker/Dockerfile.hosted-provider"
  }),
  Object.freeze({
    name: "mcp",
    repository: "ghcr.io/mdbase-dev/mdbase-connect-mcp",
    dockerfile: "deploy/docker/Dockerfile.mcp"
  })
]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await deployLocalLab(process.env, process.argv.slice(2));
}

export async function deployLocalLab(
  environment,
  args,
  {
    root = repoRoot,
    run = runCommand,
    confirm = promptForConfirmation,
    checkAuthentication = requireGhcrAuthentication,
    resolveOpsCommand = resolveCloudOpsCommand,
    now = () => Date.now(),
    random = () => randomBytes(4).toString("hex")
  } = {}
) {
  const rollbackState = parseRollbackArgs(args);
  if (!rollbackState) await requireConfirmation(args, confirm);

  const checkout = resolve(root);
  const commandEnvironment = { ...environment };
  const opsCommand = await resolveOpsCommand({ root: checkout, run, environment: commandEnvironment });
  if (rollbackState) {
    await run(opsCommand, ["rollback", "--confirm", "LAB", rollbackState], { cwd: checkout, env: commandEnvironment });
    return;
  }

  const head = (await run("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    env: commandEnvironment,
    capture: true
  })).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) {
    throw new Error("git HEAD must be a full lowercase 40-hex commit.");
  }
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: checkout,
    env: commandEnvironment,
    capture: true
  });
  const dirty = status.length > 0;

  await run(opsCommand, ["preflight"], { cwd: checkout, env: commandEnvironment });
  await run("docker", ["info"], { cwd: checkout, env: commandEnvironment });
  await run("docker", ["buildx", "version"], { cwd: checkout, env: commandEnvironment });
  await checkAuthentication(environment);

  const tag = `lab-local-${head.slice(0, 12)}-${now()}-${random()}`;
  const metadataDirectory = await mkdtemp(resolve(tmpdir(), "mdbase-lab-buildx-"));
  const images = new Map();
  try {
    await chmod(metadataDirectory, 0o700);
    for (const component of components) {
      const metadataPath = resolve(metadataDirectory, `${component.name}.json`);
      const handle = await open(metadataPath, "wx", 0o600);
      await handle.close();
      await run("docker", [
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--file",
        component.dockerfile,
        "--tag",
        `${component.repository}:${tag}`,
        "--build-arg",
        `MDBASE_CONNECT_REVISION=${head}`,
        "--push",
        "--provenance=false",
        "--metadata-file",
        metadataPath,
        "."
      ], { cwd: checkout, env: commandEnvironment });
      const digest = parseBuildxDigest(await readFile(metadataPath, "utf8"), component.name);
      images.set(component.name, `${component.repository}@${digest}`);
    }
  } finally {
    await rm(metadataDirectory, { recursive: true, force: true });
  }

  await run(opsCommand, [
    "deploy",
    "--confirm",
    "LAB",
    "--connect",
    images.get("connect"),
    "--hosted-provider",
    images.get("hosted-provider"),
    "--mcp",
    images.get("mcp"),
    "--source-revision",
    head,
    "--source-dirty",
    String(dirty),
    "--editor-checkout",
    checkout
  ], { cwd: checkout, env: commandEnvironment });
}

export function parseRollbackArgs(args) {
  if (args[0] !== "--rollback") return null;
  if (args.length !== 4 || !args[1] || args[2] !== "--confirm" || args[3] !== "LAB") {
    throw new Error("Usage: pnpm deploy:lab --rollback STATE --confirm LAB");
  }
  return args[1];
}

export async function resolveCloudOpsCommand({ root, run, environment }) {
  let expectedRoot;
  if (environment.MDBASE_CLOUD_OPS_CHECKOUT !== undefined) {
    if (!environment.MDBASE_CLOUD_OPS_CHECKOUT.startsWith("/")) {
      throw new Error("MDBASE_CLOUD_OPS_CHECKOUT must be an absolute path.");
    }
    expectedRoot = environment.MDBASE_CLOUD_OPS_CHECKOUT;
  } else {
    const commonDirectory = (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
      env: environment,
      capture: true
    })).trim();
    if (!commonDirectory.startsWith("/") || commonDirectory.length < 3) {
      throw new Error("Cannot derive the canonical mdbase projects directory from Git.");
    }
    expectedRoot = resolve(commonDirectory, "..", "..", "mdbase-cloud-ops");
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(expectedRoot);
  } catch {
    throw new Error(`Canonical sibling mdbase-cloud-ops checkout is unavailable at ${expectedRoot}.`);
  }
  if (canonicalRoot !== expectedRoot) throw new Error("Selected mdbase-cloud-ops checkout must be canonical and must not be reached through a symlink or relative segment.");
  const topLevel = (await run("git", ["rev-parse", "--show-toplevel"], {
    cwd: canonicalRoot,
    env: environment,
    capture: true
  })).trim();
  if (await realpath(topLevel) !== canonicalRoot) throw new Error("Resolved mdbase-cloud-ops path is not its Git top level.");
  const remote = (await run("git", ["remote", "get-url", "origin"], {
    cwd: canonicalRoot,
    env: environment,
    capture: true
  })).trim();
  if (!["https://github.com/mdbase-dev/mdbase-cloud-ops.git", "https://github.com/mdbase-dev/mdbase-cloud-ops", "git@github.com:mdbase-dev/mdbase-cloud-ops.git", "ssh://git@github.com/mdbase-dev/mdbase-cloud-ops.git"].includes(remote)) {
    throw new Error("Canonical mdbase-cloud-ops origin is not mdbase-dev/mdbase-cloud-ops.");
  }
  const command = resolve(canonicalRoot, "bin/deploy-local-lab");
  const commandStat = await lstat(command);
  if (!commandStat.isFile() || commandStat.isSymbolicLink() || commandStat.uid !== process.getuid() || (commandStat.mode & 0o111) === 0) {
    throw new Error("Canonical deploy-local-lab command is not a same-user regular file.");
  }
  return command;
}

export async function requireConfirmation(args, prompt = promptForConfirmation) {
  if (args.length === 2 && args[0] === "--confirm" && args[1] === "LAB") return;
  if (args.length !== 0) {
    throw new Error("Usage: pnpm deploy:lab [--confirm LAB]");
  }
  const answer = await prompt();
  if (answer !== "LAB") throw new Error("LAB deployment confirmation did not exactly match LAB.");
}

export function parseBuildxDigest(source, component) {
  let metadata;
  try {
    metadata = JSON.parse(source);
  } catch {
    throw new Error(`${component} Buildx metadata is not valid JSON.`);
  }
  const digest = metadata["containerimage.digest"];
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest ?? "")) {
    throw new Error(`${component} Buildx metadata is missing a valid containerimage.digest.`);
  }
  return digest;
}

async function promptForConfirmation() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await input.question("Type LAB to build, push, and replace the disposable LAB deployment: ");
  } finally {
    input.close();
  }
}

export async function requireGhcrAuthentication(environment) {
  let source;
  if (environment.DOCKER_AUTH_CONFIG) {
    source = environment.DOCKER_AUTH_CONFIG;
  } else {
    const dockerConfig = environment.DOCKER_CONFIG
      ? resolve(environment.DOCKER_CONFIG)
      : resolve(environment.HOME || homedir(), ".docker");
    source = await readFile(resolve(dockerConfig, "config.json"), "utf8");
  }
  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("Docker authentication configuration is not valid JSON.");
  }
  const registryKeys = ["ghcr.io", "https://ghcr.io", "https://ghcr.io/v1/"];
  const hasAuthentication = registryKeys.some((registry) =>
    Object.hasOwn(config.auths ?? {}, registry) || Object.hasOwn(config.credHelpers ?? {}, registry)
  ) || (typeof config.credsStore === "string" && config.credsStore.length > 0);
  if (!hasAuthentication) {
    throw new Error("Existing local Docker authentication for ghcr.io is required.");
  }
}

async function runCommand(command, args, { cwd, env, capture = false }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
  });
  const stdout = [];
  if (capture) child.stdout.on("data", (chunk) => stdout.push(chunk));
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`${command} was stopped by ${signal}.`));
      else resolveExit(code);
    });
  });
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}.`);
  return capture ? Buffer.concat(stdout).toString("utf8") : undefined;
}
