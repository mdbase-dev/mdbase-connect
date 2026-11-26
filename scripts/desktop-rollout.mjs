// Signs and publishes a desktop release's rollout document, or reads it back.
//
//   node scripts/desktop-rollout.mjs publish <stage>   (tagged desktop-release.yml run only)
//   node scripts/desktop-rollout.mjs status <tag>
//
// `publish` signs with the run's tag-bound Sigstore identity, the identity that
// clients require, and authenticates the upload with the run's GitHub OIDC
// token. No long-lived credential exists for the rollout service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repository, requireRunning } from "./lib/continuous-client-release.mjs";
import {
  parseRollout,
  rolloutAudience,
  rolloutBytes,
  rolloutDocument,
  rolloutService,
  rolloutUrl,
  stageOf
} from "./lib/desktop-rollout.mjs";

const issuer = "https://token.actions.githubusercontent.com";
const identity = (tag) => `https://github.com/${repository}/.github/workflows/desktop-release.yml@refs/tags/${tag}`;

function verify(path, tag) {
  execFileSync("cosign", ["verify-blob", "--bundle", `${path}.sigstore.json`,
    "--certificate-identity", identity(tag), "--certificate-oidc-issuer", issuer, path], { stdio: "inherit" });
}

async function oidcToken(env) {
  assert(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "This job needs id-token: write.");
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", rolloutAudience);
  const response = await fetch(url, { headers: { authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  assert(response.ok, `GitHub OIDC token request returned HTTP ${response.status}.`);
  const { value } = await response.json();
  assert.equal(typeof value, "string");
  return value;
}

/**
 * Reads, verifies and parses a release's rollout document. Null when the release
 * has none (it predates staged rollout, or was never published).
 */
export async function readRollout(service, tag, { verifySignature = true } = {}) {
  const url = rolloutUrl(service, tag);
  const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
  if (response.status === 404) return null;
  assert(response.ok, `${url} returned HTTP ${response.status}.`);
  const text = await response.text();
  if (verifySignature) {
    const bundle = await fetch(`${url}.sigstore.json`, { cache: "no-store" });
    assert(bundle.ok, `The rollout signature for ${tag} returned HTTP ${bundle.status}.`);
    const directory = mkdtempSync(join(tmpdir(), "desktop-rollout-"));
    try {
      const path = join(directory, "rollout.json");
      writeFileSync(path, text);
      writeFileSync(`${path}.sigstore.json`, await bundle.text());
      verify(path, tag);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return parseRollout(text, tag);
}

export async function publish(stage, env = process.env) {
  if (stage !== "held") requireRunning(env.DESKTOP_RELEASE_STOPPED);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, repository);
  const tag = env.GITHUB_REF_NAME;
  assert.equal(env.GITHUB_REF, `refs/tags/${tag}`, "Rollout documents are published from their release tag's run.");
  const service = rolloutService(env.DESKTOP_ROLLOUT_SERVICE);
  assert(service, "DESKTOP_ROLLOUT_SERVICE is not set.");
  const document = rolloutDocument(tag, stage);
  const directory = mkdtempSync(join(tmpdir(), "desktop-rollout-"));
  try {
    const path = join(directory, `${tag}.json`);
    writeFileSync(path, rolloutBytes(document));
    execFileSync("cosign", ["sign-blob", "--yes", "--bundle", `${path}.sigstore.json`, path], { stdio: "inherit" });
    verify(path, tag);
    const response = await fetch(`${service}/desktop/v1/rollout/${tag}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await oidcToken(env)}`, "content-type": "application/json" },
      body: JSON.stringify({
        document: readFileSync(path, "utf8"),
        bundle: JSON.parse(readFileSync(`${path}.sigstore.json`, "utf8"))
      })
    });
    const reply = await response.text();
    assert(response.ok, `The rollout service refused ${tag} at ${stage}: HTTP ${response.status} ${reply}`);
    const served = await readRollout(service, tag);
    assert.deepEqual(served, document, "The rollout service does not serve the document just published.");
    console.log(`${tag} rollout: ${stage} (${JSON.stringify(document)})`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function status(tag, env = process.env) {
  const service = rolloutService(env.DESKTOP_ROLLOUT_SERVICE ?? rolloutAudience);
  const document = await readRollout(service, tag, { verifySignature: env.DESKTOP_ROLLOUT_VERIFY !== "false" });
  console.log(JSON.stringify(document ? { ...document, stage: stageOf(document) } : { tag, stage: null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, argument] = process.argv.slice(2);
  if (command === "publish" && argument) await publish(argument);
  else if (command === "status" && argument) await status(argument);
  else throw new Error("Expected publish <stage> or status <tag>.");
}
