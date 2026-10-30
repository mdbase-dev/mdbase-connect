import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { publishSdkPrerelease } from "../publish-sdk-prerelease.mjs";
import { verifySdkArchive } from "./sdk-publication.mjs";

const root = resolve(import.meta.dirname, "../..");
const contract = JSON.parse(readFileSync(join(root, "config/release-components.json"))).sdkPublication;
const version = "0.0.1-next.0";
const commit = "a".repeat(40);
const tag = `sdk-v${version}`;

function fixture(context) {
  const directory = mkdtempSync(join(root, ".sdk-publication-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  function pack(environment, overrides = {}, sourceCommit = commit) {
    const packageDirectory = join(directory, environment, "package");
    mkdirSync(join(packageDirectory, "dist/native"), { recursive: true });
    const manifest = { name: contract.environments[environment].package, version,
      ...(environment === "production" ? { publishConfig: { registry: contract.productionRegistry } } : { private: true }),
      ...overrides };
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(packageDirectory, "dist/native/provenance.json"), JSON.stringify({
      schema: "mdbase-sdk/npm-publication/1", commit: sourceCommit, environment, trust: contract.environments[environment],
    }));
    const filename = environment === "production" ? "sdk-production.tgz" : contract.prerelease.assets[environment];
    execFileSync("tar", ["-czf", join(directory, filename), "-C", join(directory, environment), "package"]);
    writeFileSync(join(directory, `${filename}.sigstore.json`), JSON.stringify({ synthetic: true }));
    return join(directory, filename);
  }
  pack("staging");
  pack("lab");
  const calls = [];
  const options = { directory, version, commit, publication: { ...contract, ready: true }, token: "synthetic-token" };
  function requestWith(override = () => undefined) {
    return async (url, options) => {
      assert.equal(options.headers.Authorization, "Bearer synthetic-token");
      const pathname = new URL(url).pathname.replace("/repos/mdbase-dev/mdbase-connect/", "");
      const body = options.body && !(options.body instanceof Uint8Array) ? JSON.parse(options.body) : options.body;
      const call = { method: options.method, pathname, body };
      calls.push(call);
      let result = override(call, calls.length);
      if (!result) {
        if (options.method === "GET") {
          result = calls.some(value => value.pathname === "git/refs")
            ? [200, { object: { sha: commit } }] : [404, {}];
        } else if (pathname === "git/refs") result = [201, { object: { sha: commit } }];
        else if (pathname === "releases") result = [201, { id: 42, assets: [] }];
        else if (url.startsWith("https://uploads.github.com/")) result = [201, {
          name: new URL(url).searchParams.get("name"), size: options.body.length, state: "uploaded",
        }];
        else if (options.method === "PATCH" && pathname === "releases/42") {
          result = [200, { tag_name: tag, draft: false, prerelease: true }];
        } else throw new Error(`Unexpected synthetic request: ${url}`);
      }
      return { status: result[0], json: async () => result[1] };
    };
  }
  return { directory, pack, calls, options, requestWith };
}

test("one new tag and prerelease bind both exact packages and bundles, never Latest", async context => {
  const value = fixture(context);
  await publishSdkPrerelease({ ...value.options, request: value.requestWith() });
  assert.deepEqual(value.calls.find(call => call.pathname === "git/refs").body, { ref: `refs/tags/${tag}`, sha: commit });
  const create = value.calls.find(call => call.pathname === "releases").body;
  assert.equal(create.tag_name, tag);
  assert.equal(create.target_commitish, commit);
  assert.equal(create.prerelease, true);
  assert.equal(create.draft, true);
  assert.equal(create.make_latest, "false");
  assert.equal(value.calls.filter(call => call.pathname === "releases/42/assets").length, 4);
  assert.deepEqual(value.calls.at(-1).body, { draft: false, prerelease: true, make_latest: "false" });
  assert(!value.calls.some(call => call.method === "DELETE"));
});

for (const [name, path, status] of [
  ["existing tag", `git/ref/tags/${tag}`, 200],
  ["existing release", `releases/tags/${tag}`, 200],
  ["authorization failure", `git/ref/tags/${tag}`, 403],
  ["GitHub failure", `releases/tags/${tag}`, 503],
]) {
  test(`${name} refuses before every write`, async context => {
    const value = fixture(context);
    await assert.rejects(publishSdkPrerelease({ ...value.options,
      request: value.requestWith(call => call.pathname === path ? [status, {}] : undefined) }));
    assert(value.calls.every(call => call.method === "GET"));
  });
}

test("atomic tag conflict refuses without creating or updating any release", async context => {
  const value = fixture(context);
  await assert.rejects(publishSdkPrerelease({ ...value.options,
    request: value.requestWith(call => call.pathname === "git/refs" ? [422, {}] : undefined) }));
  assert.equal(value.calls.at(-1).pathname, "git/refs");
  assert.equal(value.calls.filter(call => call.method !== "GET").length, 1);
});

test("existing assets are never replaced or deleted", async context => {
  const value = fixture(context);
  await assert.rejects(publishSdkPrerelease({ ...value.options,
    request: value.requestWith(call => call.pathname === "releases" ? [201, { id: 42, assets: [{ name: "sdk-staging.tgz" }] }] : undefined) }));
  assert.equal(value.calls.at(-1).pathname, "releases");
});

test("an asset-name conflict fails once without overwrite, retry or publishing the draft", async context => {
  const value = fixture(context);
  await assert.rejects(publishSdkPrerelease({ ...value.options,
    request: value.requestWith(call => call.pathname === "releases/42/assets" ? [422, {}] : undefined) }));
  assert.equal(value.calls.filter(call => call.pathname === "releases/42/assets").length, 1);
  assert(!value.calls.some(call => call.method === "PATCH"));
});

test("tag mutation refuses before publishing", async context => {
  const value = fixture(context);
  await assert.rejects(publishSdkPrerelease({ ...value.options, request: value.requestWith((call, count) =>
    call.method === "GET" && count > 2 ? [200, { object: { sha: "b".repeat(40) } }] : undefined) }));
  assert(!value.calls.some(call => call.method === "PATCH"));
});

test("wrong version, source, environment, or a missing bundle refuses before GitHub", async context => {
  for (const change of [
    value => { value.options.version = "0.0.1-next.1"; },
    value => { value.pack("lab", {}, "b".repeat(40)); },
    value => { value.pack("staging", { name: "@mdbase-dev/sdk" }); },
    value => { rmSync(join(value.directory, "sdk-lab.tgz.sigstore.json")); },
    value => { value.options.publication = { ...contract, ready: false }; },
  ]) {
    const value = fixture(context);
    change(value);
    await assert.rejects(publishSdkPrerelease({ ...value.options, request: value.requestWith() }));
    assert.equal(value.calls.length, 0);
  }
});

test("the npm publisher admits only production identity and registry", context => {
  const value = fixture(context);
  const verify = archive => verifySdkArchive(archive, "production", version, commit, contract);
  verify(value.pack("production"));
  for (const environment of ["staging", "lab"]) assert.throws(() => verify(join(value.directory, contract.prerelease.assets[environment])));
  assert.throws(() => verify(value.pack("production", { private: true })));
  assert.throws(() => verify(value.pack("production", { publishConfig: { registry: "https://npm.pkg.github.com/" } })));
});
