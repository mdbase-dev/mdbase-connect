import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const developmentDeployment = Object.freeze({
  editorOrigin: "https://editor-staging.mdbase.dev",
  connectOrigin: "https://connect-staging.mdbase.dev",
  project: "mdbase-editor",
  branch: "staging",
  domain: "editor-staging.mdbase.dev",
  wranglerVersion: "4.114.0"
});

const repoRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(repoRoot, "apps/editor/public/.well-known/mdbase-app.json");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await deployDevelopmentEditor(process.env);
}

export async function deployDevelopmentEditor(environment, run = runCommand) {
  const previousManifest = await readFile(manifestPath);
  const deploymentEnvironment = {
    ...environment,
    MDBASE_EDITOR_ORIGIN: developmentDeployment.editorOrigin,
    MDBASE_EDITOR_BASE_PATH: "/",
    VITE_MDBASE_CONNECT_URL: developmentDeployment.connectOrigin
  };

  try {
    await run("pnpm", ["build:packages"], deploymentEnvironment);
    await run("pnpm", ["--filter", "mdbase-editor", "build"], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      "apps/editor/dist/.well-known/mdbase-app.json",
      `${developmentDeployment.editorOrigin}/`
    ], deploymentEnvironment);
    await run("pnpm", [
      "dlx",
      `wrangler@${developmentDeployment.wranglerVersion}`,
      "pages",
      "deploy",
      "apps/editor/dist",
      `--project-name=${developmentDeployment.project}`,
      `--branch=${developmentDeployment.branch}`
    ], deploymentEnvironment);
    await run("node", [
      "apps/editor/scripts/verify-deployment-manifest.mjs",
      `${developmentDeployment.editorOrigin}/.well-known/mdbase-app.json`,
      `${developmentDeployment.editorOrigin}/`
    ], {
      ...deploymentEnvironment,
      MDBASE_MANIFEST_VERIFY_ATTEMPTS: "12",
      MDBASE_MANIFEST_VERIFY_DELAY_MS: "5000"
    });
    await run("node", [
      "apps/editor/scripts/verify-deployment-assets.mjs",
      "apps/editor/dist/assets",
      `${developmentDeployment.editorOrigin}/`
    ], {
      ...deploymentEnvironment,
      MDBASE_ASSET_VERIFY_ATTEMPTS: "61",
      MDBASE_ASSET_VERIFY_DELAY_MS: "5000"
    });
  } finally {
    await writeFile(manifestPath, previousManifest);
  }

  console.log(`Development editor deployed: ${developmentDeployment.editorOrigin}/`);
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
