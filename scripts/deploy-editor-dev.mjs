import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const stagingDevelopmentDeployment = Object.freeze({
  editorOrigin: "https://editor-staging.mdbase.dev",
  connectOrigin: "https://connect-staging.mdbase.dev",
  project: "mdbase-editor",
  branch: "staging",
  domain: "editor-staging.mdbase.dev",
  wranglerVersion: "4.114.0"
});

export const labDevelopmentDeployment = Object.freeze({
  editorOrigin: "https://candidate-b.mdbase-editor.pages.dev",
  connectOrigin: "https://mdbase-connect-lab.onrender.com",
  project: "mdbase-editor",
  branch: "candidate-b",
  domain: "candidate-b.mdbase-editor.pages.dev",
  wranglerVersion: "4.114.0"
});

export const developmentDeployment = labDevelopmentDeployment;

const repoRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(repoRoot, "apps/editor/public/.well-known/mdbase-app.json");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await deployDevelopmentEditor(process.env);
}

export async function deployDevelopmentEditor(environment, run = runCommand) {
  const deployment = developmentDeploymentFor(environment);
  const previousManifest = await readFile(manifestPath);
  const deploymentEnvironment = {
    ...environment,
    MDBASE_ENV: environment.MDBASE_ENV?.trim() || "lab",
    VITE_MDBASE_ENV: environment.MDBASE_ENV?.trim() || "lab",
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

  console.log(`Development editor deployed: ${deployment.editorOrigin}/`);
}

export function developmentDeploymentFor(environment) {
  const target = environment.MDBASE_ENV?.trim() || "lab";
  const deployment = target === "lab"
    ? labDevelopmentDeployment
    : target === "staging"
      ? stagingDevelopmentDeployment
      : null;
  if (!deployment) {
    throw new Error("deploy:dev supports MDBASE_ENV=lab or MDBASE_ENV=staging only.");
  }
  const requestedOrigin = environment.MDBASE_CONNECT_URL?.trim();
  if (requestedOrigin && requestedOrigin !== deployment.connectOrigin) {
    throw new Error(
      `${target} editor deployment requires ${deployment.connectOrigin}, received ${requestedOrigin}.`
    );
  }
  return deployment;
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
