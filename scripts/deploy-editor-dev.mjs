import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  managedEnvironments,
  normalizedEndpointOrigin
} from "./lib/managed-environments.mjs";

export const developmentDeployments = Object.freeze({
  lab: Object.freeze({
    ...managedEnvironments.lab,
    project: "mdbase-editor",
    branch: "candidate-b",
    wranglerVersion: "4.114.0"
  }),
  staging: Object.freeze({
    ...managedEnvironments.staging,
    project: "mdbase-editor",
    branch: "staging",
    wranglerVersion: "4.114.0"
  })
});
export const developmentDeployment = developmentDeployments.lab;

const repoRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(repoRoot, "apps/editor/public/.well-known/mdbase-app.json");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await deployDevelopmentEditor(process.env);
}

export async function deployDevelopmentEditor(environment, run = runCommand) {
  const target = environment.MDBASE_ENV?.trim() || "lab";
  if (target !== "lab" && target !== "staging") {
    throw new Error("Development editor deployments are restricted to lab and staging.");
  }
  const deployment = developmentDeployments[target];
  const requestedOrigin = environment.MDBASE_CONNECT_URL?.trim()
    ? normalizedEndpointOrigin(
        environment.MDBASE_CONNECT_URL,
        "MDBASE_CONNECT_URL"
      )
    : undefined;
  if (requestedOrigin && requestedOrigin !== deployment.connectOrigin) {
    throw new Error(`MDBASE_CONNECT_URL does not match the ${target} environment.`);
  }
  const previousManifest = await readFile(manifestPath);
  const deploymentEnvironment = {
    ...environment,
    MDBASE_ENV: target,
    VITE_MDBASE_ENV: target,
    MDBASE_EDITOR_ORIGIN: deployment.editorOrigin,
    MDBASE_EDITOR_BASE_PATH: "/",
    MDBASE_CONNECT_URL: deployment.connectOrigin,
    VITE_MDBASE_CONNECT_URL: deployment.connectOrigin
  };

  try {
    await run("pnpm", ["build:packages"], deploymentEnvironment);
    await run("pnpm", ["--filter", "mdbase-editor", "build"], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      "apps/editor/dist/.well-known/mdbase-app.json",
      `${deployment.editorOrigin}/`,
      deployment.connectOrigin
    ], deploymentEnvironment);
    await run("pnpm", [
      "dlx",
      `wrangler@${deployment.wranglerVersion}`,
      "pages",
      "deploy",
      "apps/editor/dist",
      `--project-name=${deployment.project}`,
      `--branch=${deployment.branch}`
    ], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      `${deployment.editorOrigin}/.well-known/mdbase-app.json`,
      `${deployment.editorOrigin}/`,
      deployment.connectOrigin
    ], {
      ...deploymentEnvironment,
      MDBASE_MANIFEST_VERIFY_ATTEMPTS: "12",
      MDBASE_MANIFEST_VERIFY_DELAY_MS: "5000"
    });
    await run("node", [
      "apps/editor/scripts/verify-deployment-assets.mjs",
      "apps/editor/dist/assets",
      `${deployment.editorOrigin}/`
    ], {
      ...deploymentEnvironment,
      MDBASE_ASSET_VERIFY_ATTEMPTS: "61",
      MDBASE_ASSET_VERIFY_DELAY_MS: "5000"
    });
  } finally {
    await writeFile(manifestPath, previousManifest);
  }

  console.log(`${target.toUpperCase()} editor deployed: ${deployment.editorOrigin}/`);
}

async function runCommand(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit"
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`${command} was stopped by ${signal}.`));
      else resolveExit(code);
    });
  });
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}.`);
}
