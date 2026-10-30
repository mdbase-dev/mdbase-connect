import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireSdkPublicationReady, sdkReleaseTag, validateSdkPublication, verifySdkArchive } from "./lib/sdk-publication.mjs";

const repository = "mdbase-dev/mdbase-connect";

export async function publishSdkPrerelease({ directory, version, commit, publication, token, request = fetch }) {
  validateSdkPublication(publication, resolve(import.meta.dirname, ".."));
  requireSdkPublicationReady(publication);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(typeof token, "string");
  assert(token.length > 0, "GitHub release token is required");
  const tag = sdkReleaseTag(publication, version);
  const files = [];
  for (const [environment, name] of Object.entries(publication.prerelease.assets)) {
    verifySdkArchive(join(directory, name), environment, version, commit, publication);
    const bundle = JSON.parse(readFileSync(join(directory, `${name}.sigstore.json`)));
    assert(bundle && typeof bundle === "object" && !Array.isArray(bundle));
    for (const filename of [name, `${name}.sigstore.json`]) {
      files.push({ name: filename, bytes: readFileSync(join(directory, filename)) });
    }
  }
  const headers = {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
  };
  const api = (path, method = "GET", body) => request(`https://api.github.com/repos/${repository}/${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (response, expectedStatus) => {
    assert.equal(response.status, expectedStatus, `GitHub SDK prerelease refused: HTTP ${response.status}`);
    return response.json();
  };
  for (const path of [`git/ref/tags/${tag}`, `releases/tags/${tag}`]) {
    const response = await api(path);
    assert.equal(response.status, 404,
      `SDK tag/release must be absent; HTTP ${response.status} is not absence proof`);
  }
  const ref = await json(await api("git/refs", "POST", { ref: `refs/tags/${tag}`, sha: commit }), 201);
  assert.equal(ref.object.sha, commit);
  const release = await json(await api("releases", "POST", {
    tag_name: tag, target_commitish: commit, name: `SDK ${version}: staging and LAB`,
    body: `Source: ${commit}. Packages and attached Sigstore bundles were produced by publish-sdk-npm.yml.`,
    draft: true, prerelease: true, make_latest: "false",
  }), 201);
  assert(Number.isSafeInteger(release.id) && release.id > 0);
  assert.deepEqual(release.assets, [], "refuse any release with existing assets");
  for (const file of files) {
    const uploaded = await json(await request(
      `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: file.bytes },
    ), 201);
    assert.equal(uploaded.name, file.name);
    assert.equal(uploaded.size, file.bytes.length);
    assert.equal(uploaded.state, "uploaded");
  }
  const currentRef = await json(await api(`git/ref/tags/${tag}`), 200);
  assert.equal(currentRef.object.sha, commit, "SDK tag changed before publication");
  const published = await json(await api(`releases/${release.id}`, "PATCH", {
    draft: false, prerelease: true, make_latest: "false",
  }), 200);
  assert.equal(published.tag_name, tag);
  assert.equal(published.draft, false);
  assert.equal(published.prerelease, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, "..");
  const publication = JSON.parse(readFileSync(join(root, "config/release-components.json"))).sdkPublication;
  const { version } = JSON.parse(readFileSync(join(root, "runtime/packages/sdk/package.json")));
  await publishSdkPrerelease({ directory: resolve(process.argv[2]), version,
    commit: process.env.GITHUB_SHA, publication, token: process.env.GH_TOKEN });
}
