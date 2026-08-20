import assert from "node:assert/strict";
import test from "node:test";
import {
  deployDevelopmentEditor,
  developmentDeployment,
  developmentDeploymentFor,
  stagingDevelopmentDeployment
} from "./deploy-editor-dev.mjs";

test("deploy:dev targets the isolated lab environment by default", async () => {
  const calls = [];
  await deployDevelopmentEditor({}, async (command, args, environment) => {
    calls.push({ command, args, environment });
  });

  const build = calls.find(({ args }) => args.includes("mdbase-editor") && args.includes("build"));
  assert.equal(build.environment.MDBASE_EDITOR_ORIGIN, developmentDeployment.editorOrigin);
  assert.equal(build.environment.MDBASE_CONNECT_URL, developmentDeployment.connectOrigin);
  assert.equal(build.environment.VITE_MDBASE_CONNECT_URL, developmentDeployment.connectOrigin);

  const manifestChecks = calls.filter(({ args }) => args.includes("apps/editor/scripts/verify-deployment-manifest.mjs"));
  assert.equal(manifestChecks.length, 2);
  for (const check of manifestChecks) {
    assert.equal(check.args.at(-1), developmentDeployment.connectOrigin);
  }

  const deploy = calls.find(({ args }) => args.includes("wrangler@4.114.0"));
  assert.ok(deploy);
  assert.ok(deploy.args.includes("--project-name=mdbase-editor"));
  assert.ok(deploy.args.includes("--branch=candidate-b"));

});

test("staging remains an explicit release-rehearsal target", () => {
  assert.equal(developmentDeploymentFor({ MDBASE_ENV: "staging" }), stagingDevelopmentDeployment);
});

test("development deployments reject production and mismatched origins", () => {
  assert.throws(() => developmentDeploymentFor({ MDBASE_ENV: "production" }), /supports/);
  assert.throws(() => developmentDeploymentFor({
    MDBASE_ENV: "lab",
    MDBASE_CONNECT_URL: "https://connect.mdbase.dev"
  }), /requires/);
});
