import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { findLatestRelease } = require("../dist/main/release-source.js");

const indexUrl =
  "https://api.github.com/repos/mdbase-dev/mdbase-connect/releases?per_page=20";

function manifest(version = "0.1.0-beta.9") {
  const tag = `v${version}`;
  return {
    schema_version: 1,
    version,
    tag,
    channel: "beta",
    published_at: "2026-07-28T00:00:00.000Z",
    release_url: `https://github.com/mdbase-dev/mdbase-connect/releases/tag/${tag}`,
    notes: "Verified notes.",
    rollout: { percentage: 100, seed: tag },
    blocked_versions: [],
    targets: {
      "darwin-arm64": {
        mode: "automatic",
        action_url: `https://github.com/mdbase-dev/mdbase-connect/releases/tag/${tag}`,
        artifacts: [
          {
            name: `mdbase-connect-${version}.zip`,
            url: `https://example.com/mdbase-connect-${version}.zip`,
            sigstore_url: `https://example.com/mdbase-connect-${version}.zip.sigstore.json`,
            sha256: "c".repeat(64),
            size: 42,
            kind: "zip"
          }
        ]
      }
    }
  };
}

function release(version) {
  const tag = `v${version}`;
  return {
    draft: false,
    prerelease: true,
    tag_name: tag,
    html_url: `https://github.com/mdbase-dev/mdbase-connect/releases/tag/${tag}`,
    assets: [
      {
        name: "mdbase-connect-update.json",
        browser_download_url: `https://downloads.example/${tag}/manifest`,
        size: 1000
      },
      {
        name: "mdbase-connect-update.json.sigstore.json",
        browser_download_url: `https://downloads.example/${tag}/bundle`,
        size: 1000
      }
    ]
  };
}

function fetchMap(entries) {
  return async (url) => {
    const key = String(url);
    if (!(key in entries)) throw new Error(`Unexpected URL ${key}`);
    const value = entries[key];
    const body = typeof value === "string" ? value : JSON.stringify(value);
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) }
    });
    Object.defineProperty(response, "url", { value: key });
    return response;
  };
}

test("release discovery verifies the exact workflow-and-tag identity", async () => {
  const candidate = release("0.1.0-beta.9");
  const calls = [];
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap({
      [indexUrl]: [candidate],
      [candidate.assets[0].browser_download_url]: manifest(),
      [candidate.assets[1].browser_download_url]: { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3" }
    }),
    async verifyBundle(bundle, payload, identity, cache) {
      calls.push({ bundle, payload: JSON.parse(payload), identity, cache });
    }
  });
  assert.equal(result.manifest.version, "0.1.0-beta.9");
  assert.equal(
    calls[0].identity,
    "https://github.com/mdbase-dev/mdbase-connect/.github/workflows/desktop-release.yml@refs/tags/v0.1.0-beta.9"
  );
  assert.equal(calls[0].cache, "/tmp/not-used");
});

test("the highest verified semantic version wins even when API order is hostile", async () => {
  const beta9 = release("0.1.0-beta.9");
  const beta10 = release("0.1.0-beta.10");
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap({
      [indexUrl]: [beta9, beta10],
      [beta9.assets[0].browser_download_url]: manifest("0.1.0-beta.9"),
      [beta9.assets[1].browser_download_url]: {},
      [beta10.assets[0].browser_download_url]: manifest("0.1.0-beta.10"),
      [beta10.assets[1].browser_download_url]: {}
    }),
    async verifyBundle() {}
  });
  assert.equal(result.manifest.version, "0.1.0-beta.10");
});

test("a manifest is not parsed or trusted when signature verification fails", async () => {
  const candidate = release("0.1.0-beta.9");
  await assert.rejects(
    findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: fetchMap({
        [indexUrl]: [candidate],
        [candidate.assets[0].browser_download_url]: "{not valid json",
        [candidate.assets[1].browser_download_url]: {}
      }),
      async verifyBundle() {
        throw new Error("untrusted signer");
      }
    }),
    /untrusted signer/
  );
});

test("signed metadata cannot claim a different GitHub release", async () => {
  const candidate = release("0.1.0-beta.9");
  const wrong = manifest();
  wrong.release_url =
    "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.10";
  await assert.rejects(
    findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: fetchMap({
        [indexUrl]: [candidate],
        [candidate.assets[0].browser_download_url]: wrong,
        [candidate.assets[1].browser_download_url]: {}
      }),
      async verifyBundle() {}
    }),
    /does not match its release page/
  );
});

test("oversized release metadata is rejected before parsing", async () => {
  const response = new Response("[]", {
    status: 200,
    headers: { "content-length": String(3 * 1024 * 1024) }
  });
  Object.defineProperty(response, "url", { value: indexUrl });
  await assert.rejects(
    findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: async () => response,
      async verifyBundle() {}
    }),
    /size limit/
  );
});
