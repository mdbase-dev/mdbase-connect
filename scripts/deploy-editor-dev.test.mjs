import assert from "node:assert/strict";
import test from "node:test";
import { deployDevelopmentEditor, developmentDeployments } from "./deploy-editor-dev.mjs";

test("builds and deploys the editor against lab by default", async () => {
  const calls = [];
  await deployDevelopmentEditor({
    MDBASE_CONNECT_URL: `${developmentDeployments.lab.connectOrigin}/`
  }, async (command, args, environment) => {
    calls.push({ command, args, environment });
  });

  const build = calls.find(({ args }) => args.includes("mdbase-editor") && args.includes("build"));
  assert.equal(build.environment.MDBASE_ENV, "lab");
  assert.equal(build.environment.VITE_MDBASE_ENV, "lab");
  assert.equal(build.environment.MDBASE_EDITOR_ORIGIN, developmentDeployments.lab.editorOrigin);
  assert.equal(build.environment.MDBASE_CONNECT_URL, developmentDeployments.lab.connectOrigin);
  assert.equal(build.environment.VITE_MDBASE_CONNECT_URL, developmentDeployments.lab.connectOrigin);

  const manifestChecks = calls.filter(({ args }) => args.includes("apps/editor/scripts/verify-deployment-manifest.mjs"));
  assert.equal(manifestChecks.length, 2);
  for (const check of manifestChecks) {
    assert.equal(check.args.at(-1), developmentDeployments.lab.connectOrigin);
  }

  const deploy = calls.find(({ args }) => args.includes("wrangler@4.114.0"));
  assert.ok(deploy);
  assert.ok(deploy.args.includes("--project-name=mdbase-editor"));
  assert.ok(deploy.args.includes("--branch=candidate-b"));
});

test("allows the experimental collaboration build only in LAB", async () => {
  const calls = [];
  await deployDevelopmentEditor({
    MDBASE_ENV: "lab",
    MDBASE_EDITOR_EXPERIMENTAL_HOSTED_COLLABORATION: "1"
  }, async (command, args, environment) => {
    calls.push({ command, args, environment });
  });
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ environment }) =>
    environment.MDBASE_EDITOR_EXPERIMENTAL_HOSTED_COLLABORATION === "1"));
  await assert.rejects(
    deployDevelopmentEditor({
      MDBASE_ENV: "staging",
      MDBASE_EDITOR_EXPERIMENTAL_HOSTED_COLLABORATION: "1"
    }, async () => undefined),
    /restricted to LAB/
  );
});

test("staging requires an explicit environment and production is rejected", async () => {
  const calls = [];
  await deployDevelopmentEditor({ MDBASE_ENV: "staging" }, async (command, args, environment) => {
    calls.push({ command, args, environment });
  });
  const deploy = calls.find(({ args }) => args.includes("wrangler@4.114.0"));
  assert.ok(deploy.args.includes("--branch=staging"));
  assert.equal(deploy.environment.MDBASE_CONNECT_URL, developmentDeployments.staging.connectOrigin);
  assert.equal(deploy.environment.VITE_MDBASE_ENV, "staging");

  await assert.rejects(
    deployDevelopmentEditor({ MDBASE_ENV: "production" }, async () => undefined),
    /restricted to lab and staging/
  );
  await assert.rejects(
    deployDevelopmentEditor({ MDBASE_ENV: "lab", MDBASE_CONNECT_URL: developmentDeployments.staging.connectOrigin }, async () => undefined),
    /does not match the lab environment/
  );
});
