import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyPublicationSource, verifyProductionReadiness, verifyRemotePublicationTag } from "../verify-client-publication.mjs";

const sha = "a".repeat(40);
const source = { event: "workflow_dispatch", ref: "refs/tags/v0.1.0-beta.96", sha, head: sha, version: "0.1.0-beta.96", verifiedCommit: sha };
const responses = [
  { ok: true, service: "mdbase-connect", revision: sha, environment: "production", public_origin: "https://connect.mdbase.dev", protocol_version: 1, capabilities: ["application-authorization-v2-issuance"] },
  { ok: true, service: "mdbase-connect" },
  { status: "ready", provider: { version: source.version, capabilities: ["application-authorization-v2-issuance"] }, notifications: { recovery: "ok", consecutive_failures: 0 } },
  { ok: true, service: "mdbase-mcp", revision: sha }
];
function fakeFetch(values = structuredClone(responses)) {
  let index = 0;
  return async (url, options) => {
    assert.equal(url, ["https://connect.mdbase.dev/health", "https://connect.mdbase.dev/ready", "https://sync.mdbase.dev/ready", "https://mcp.mdbase.dev/health"][index]);
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => values[index++] };
  };
}
test("only exact tagged independently verified dispatch source qualifies", () => {
  verifyPublicationSource(source);
  for (const change of [
    { event: "push" }, { ref: "refs/heads/main" }, { head: "b".repeat(40) },
    { sha: "a" }, { version: "0.1.0-beta.95" }, { verifiedCommit: undefined },
    { verifiedCommit: "true" }, { verifiedCommit: "b".repeat(40) }
  ]) assert.throws(() => verifyPublicationSource({ ...source, ...change }));
});
test("canonical exact production endpoints with fresh-v2 evidence qualify", async () => {
  await verifyProductionReadiness(sha, source.version, fakeFetch());
});
test("missing, stale, disabled, staging and wrong-service evidence fails closed", async () => {
  for (const [index, change] of [
    [0, { revision: undefined }], [0, { revision: "b".repeat(40) }],
    [0, { environment: "staging" }], [0, { public_origin: "https://connect-staging.mdbase.dev" }],
    [0, { service: "other" }], [0, { ok: false }], [0, { protocol_version: 2 }],
    [0, { capabilities: [] }], [0, { capabilities: undefined }],
    [0, { capabilities: ["application-authorization-v2-issuance", null] }],
    [1, { ok: false }], [1, { service: "other" }],
    [2, { status: "not_ready" }], [2, { provider: undefined }],
    [2, { notifications: { recovery: "failed", consecutive_failures: 1 } }],
    [2, { provider: { version: "0.1.0-beta.95", capabilities: [] } }],
    [2, { provider: { version: source.version, capabilities: [] } }],
    [2, { provider: { version: source.version, capabilities: ["application-authorization-v2-issuance", null] } }],
    [3, { revision: undefined }], [3, { revision: "b".repeat(40) }],
    [3, { service: "mdbase-connect" }], [3, { ok: false }]
  ]) {
    const values = structuredClone(responses);
    Object.assign(values[index], change);
    await assert.rejects(verifyProductionReadiness(sha, source.version, fakeFetch(values)));
  }
  for (let index = 0; index < responses.length; index++) {
    const values = structuredClone(responses);
    values[index] = null;
    await assert.rejects(verifyProductionReadiness(sha, source.version, fakeFetch(values)));
  }
});
test("HTTP, redirect, timeout and malformed JSON failures cannot qualify", async () => {
  await assert.rejects(verifyProductionReadiness(sha, source.version, async () => ({ ok: false, status: 503 })));
  for (const message of ["redirect", "timeout", "invalid JSON"]) {
    await assert.rejects(verifyProductionReadiness(sha, source.version, async () => { throw new Error(message); }));
  }
});
const workflow = async (name) => readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
test("npm and desktop cannot publish on a tag push; dispatches retain exact qualification", async () => {
  for (const name of ["publish-npm", "desktop-release"]) {
    const text = await workflow(name);
    assert.doesNotMatch(text, /^  push:/m);
    assert.match(text, /workflow_dispatch:\n    inputs:\n      production_verified_commit:/);
    assert.match(text, /if: github.event_name == 'workflow_dispatch' && startsWith\(github.ref, 'refs\/tags\/v'\)/);
    assert.match(text, /scripts\/ci\/verify-qualified-commit "\$GITHUB_SHA"/);
    const mutation = text.indexOf(name === "publish-npm" ? "npm publish " : "gh release create ");
    const guard = text.indexOf("run: node scripts/verify-client-publication.mjs");
    assert.ok(guard > 0 && guard < mutation);
    assert.match(text, /PRODUCTION_VERIFIED_COMMIT: \$\{\{ inputs.production_verified_commit \}\}/);
    assert.match(text, /node-version: 24/);
  }
  const desktop = await workflow("desktop-release");
  assert.match(desktop, /website-update:[\s\S]*needs: publish/);
  assert.match(desktop, /test "v\$package_version" = "\$GITHUB_REF_NAME"/);
});
test("Editor production uses exact tag, full qualification and live guard; staging remains on main", async () => {
  const text = await workflow("editor-pages");
  const production = text.split("  deploy-cloudflare:\n")[1].split("  deploy-cloudflare-staging:\n")[0];
  assert.match(production, /startsWith\(github.ref, 'refs\/tags\/v'\)/);
  assert.doesNotMatch(production, /github.ref == 'refs\/heads\/main'/);
  assert.match(production, /scripts\/ci\/verify-qualified-commit "\$GITHUB_SHA"/);
  assert.ok(production.indexOf("run: node scripts/verify-client-publication.mjs") < production.indexOf("wrangler pages deploy"));
  assert.match(text.split("  deploy-cloudflare-staging:\n")[1], /github.ref == 'refs\/heads\/main'/);
});

test("remote annotated tag must still identify the exact version and commit", () => {
  const tagSha = "c".repeat(40);
  const ref = { ref: source.ref, object: { type: "tag", sha: tagSha } };
  const target = { tag: "v0.1.0-beta.96", object: { type: "commit", sha } };
  const api = (reference = ref, object = target) => (path) => {
    if (path === "git/ref/tags/v0.1.0-beta.96") return reference;
    assert.equal(path, `git/tags/${tagSha}`);
    return object;
  };
  verifyRemotePublicationTag(source, api());
  for (const invalid of [
    { ...ref, ref: "refs/tags/v0.1.0-beta.95" },
    { ...ref, object: { type: "commit", sha } },
    { ...ref, object: { type: "tag", sha: "../other" } },
    { ...ref, object: undefined }
  ]) assert.throws(() => verifyRemotePublicationTag(source, api(invalid)));
  for (const invalid of [
    { ...target, tag: "v0.1.0-beta.95" },
    { ...target, object: { type: "commit", sha: "b".repeat(40) } },
    { ...target, object: { type: "tag", sha } },
    { ...target, object: undefined }
  ]) assert.throws(() => verifyRemotePublicationTag(source, api(ref, invalid)));
  assert.throws(() => verifyRemotePublicationTag(source, () => { throw new Error("tag unavailable"); }));
});
