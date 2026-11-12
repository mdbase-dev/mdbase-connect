import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  findLatestRelease,
  isRecoverableTrustCacheError,
  parsePktLines,
  recoverTrustCache
} = require("../dist/main/release-source.js");

const tagIndexUrl = "https://github.com/mdbase-dev/mdbase-connect.git/git-upload-pack";
const manifestUrl = (tag) =>
  `https://github.com/mdbase-dev/mdbase-connect/releases/download/${tag}/mdbase-connect-channel-v1.json`;
const bundleUrl = (tag) => `${manifestUrl(tag)}.sigstore.json`;

function pkt(line) {
  return (Buffer.byteLength(line) + 4).toString(16).padStart(4, "0") + line;
}

/** A protocol-v2 `ls-refs` response listing `tags`. */
function tagIndex(tags) {
  return tags.map((tag) => pkt(`${"a".repeat(40)} refs/tags/${tag}\n`)).join("") + "0000";
}

function manifest(version = "0.1.0-beta.9") {
  const tag = `v${version}`;
  return {
    schema_version: 1,
    version,
    tag,
    channel: version.includes("-") ? "beta" : "stable",
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

/** The tag index plus a published release (manifest and bundle) for each of `released`. */
function releases(tags, released, overrides = {}) {
  const entries = { [tagIndexUrl]: tagIndex(tags) };
  for (const version of released) {
    entries[manifestUrl(`v${version}`)] = manifest(version);
    entries[bundleUrl(`v${version}`)] = {};
  }
  return { ...entries, ...overrides };
}

/** Serves `entries`; any other release download is a 404, as for a tag with no release. */
function fetchMap(entries, calls = []) {
  return async (url, init) => {
    const key = String(url);
    calls.push(key);
    if (!(key in entries)) {
      if (key.startsWith("https://github.com/mdbase-dev/mdbase-connect/releases/download/")) {
        return new Response("Not Found", { status: 404 });
      }
      throw new Error(`Unexpected URL ${key}`);
    }
    const value = entries[key];
    if (typeof value === "number") return new Response(null, { status: value });
    const body = typeof value === "string" ? value : JSON.stringify(value);
    const response = new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) }
    });
    Object.defineProperty(response, "url", { value: key });
    return response;
  };
}

for (const stalled of ["headers", "index-body", "manifest-body", "bundle-body"]) {
  test(`check cancellation aborts stalled ${stalled} without trusting metadata`, { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const responses = fetchMap(releases(["v0.1.0-beta.9"], ["0.1.0-beta.9"]));
    const stalledUrl = {
      "index-body": tagIndexUrl,
      "manifest-body": manifestUrl("v0.1.0-beta.9"),
      "bundle-body": bundleUrl("v0.1.0-beta.9")
    }[stalled];
    const pending = findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      signal: controller.signal,
      async fetchImpl(url, { signal }) {
        if (stalled === "headers") {
          started.resolve();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        if (url !== stalledUrl) return responses(url);
        const body = new ReadableStream({
          start(stream) {
            stream.enqueue(Buffer.from("{"));
            signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
          }
        });
        const response = new Response(body);
        Object.defineProperty(response, "url", { value: url });
        started.resolve();
        return response;
      },
      async verifyBundle() { assert.fail("Incomplete metadata must not be verified."); }
    });
    const rejected = assert.rejects(pending, /check deadline/);
    await started.promise;
    controller.abort(new Error("check deadline"));
    await rejected;
  });
}

test("cancelled verification cannot trust a late result or try another release", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers();
  const verification = Promise.withResolvers();
  const pending = findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    signal: controller.signal,
    fetchImpl: fetchMap(releases(["v0.1.0-beta.9", "v0.1.0-beta.10"], ["0.1.0-beta.9", "0.1.0-beta.10"])),
    async verifyBundle() {
      started.resolve();
      await verification.promise;
    }
  });
  const rejected = assert.rejects(pending, /check deadline/);
  await started.promise;
  controller.abort(new Error("check deadline"));
  verification.resolve();
  await rejected;
});

test("release discovery lists tags with one ls-refs request and verifies the exact workflow-and-tag identity", async () => {
  const calls = [];
  const requests = [];
  const responses = fetchMap(releases(["v0.1.0-beta.9"], ["0.1.0-beta.9"], {
    [bundleUrl("v0.1.0-beta.9")]: { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3" }
  }));
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: async (url, init) => {
      requests.push({ url, method: init.method, headers: init.headers, body: init.body });
      return responses(url, init);
    },
    async verifyBundle(bundle, payload, identity, cache) {
      calls.push({ bundle, payload: JSON.parse(payload), identity, cache });
    }
  });
  assert.equal(result.manifest.version, "0.1.0-beta.9");
  assert.deepEqual(result.release, {
    tag: "v0.1.0-beta.9",
    url: "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.9"
  });
  assert.equal(
    calls[0].identity,
    "https://github.com/mdbase-dev/mdbase-connect/.github/workflows/desktop-release.yml@refs/tags/v0.1.0-beta.9"
  );
  assert.equal(calls[0].cache, "/tmp/not-used");
  assert.deepEqual(requests[0], {
    url: tagIndexUrl,
    method: "POST",
    headers: {
      accept: "application/x-git-upload-pack-result",
      "content-type": "application/x-git-upload-pack-request",
      "git-protocol": "version=2",
      "user-agent": "mdbase-connect-updater"
    },
    body: "0014command=ls-refs\n0017object-format=sha1\n0001001bref-prefix refs/tags/v\n0000"
  });
});

test("a check never spends GitHub's REST API quota", async () => {
  const calls = [];
  const tags = Array.from({ length: 200 }, (_, i) => `v0.1.0-beta.${i + 1}`);
  await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap(releases(tags, ["0.1.0-beta.150"]), calls),
    async verifyBundle() {}
  });
  assert.equal(calls.filter((url) => url === tagIndexUrl).length, 1);
  assert.ok(calls.every((url) => url.startsWith("https://github.com/mdbase-dev/mdbase-connect")), calls.join("\n"));
});

test("only the highest released version is verified, whatever the ref order", async () => {
  const verified = [];
  const tags = ["v0.1.0-beta.9", "v0.1.0-beta.100", "v0.1.0-beta.10", "v0.1.0-beta.2"];
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap(releases(tags, ["0.1.0-beta.9", "0.1.0-beta.100", "0.1.0-beta.10", "0.1.0-beta.2"])),
    async verifyBundle(_bundle, payload) {
      verified.push(JSON.parse(payload).version);
    }
  });
  assert.equal(result.manifest.version, "0.1.0-beta.100");
  assert.deepEqual(verified, ["0.1.0-beta.100"]);
});

test("tags without a published release are skipped across probe batches", async () => {
  const calls = [];
  const tags = [
    ...Array.from({ length: 40 }, (_, i) => `v0.1.0-beta.${i + 1}`),
    "v0.1.0", "v1", "vnext", "v0.1.0+build", "v0.1.0-beta.01x."
  ];
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap(releases(tags, ["0.1.0-beta.3", "0.1.0-beta.21"]), calls),
    async verifyBundle() {}
  });
  assert.equal(result.manifest.version, "0.1.0-beta.21");
  const probed = calls.filter((url) => url.endsWith("/mdbase-connect-channel-v1.json"));
  // Newest first, in batches of eight: beta.40 through beta.17. Nothing older.
  assert.deepEqual(probed, Array.from({ length: 24 }, (_, i) => manifestUrl(`v0.1.0-beta.${40 - i}`)));
});

test("discovery reaches a stable release behind newer prerelease tags", async () => {
  const calls = [];
  const tags = [...Array.from({ length: 30 }, (_, i) => `v0.1.0-beta.${i + 1}`), "v0.1.0", "v0.2.0-beta.1"];
  const result = await findLatestRelease({
    channel: "stable",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap(releases(tags, ["0.1.0", "0.2.0-beta.1"]), calls),
    async verifyBundle() {}
  });
  assert.equal(result.manifest.version, "0.1.0");
  assert.deepEqual(calls, [tagIndexUrl, manifestUrl("v0.1.0"), bundleUrl("v0.1.0")]);
});

test("a channel with no published release finds nothing", async () => {
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap(releases(["v0.1.0-beta.1", "v0.1.0-beta.2"], [])),
    async verifyBundle() { assert.fail("nothing to verify"); }
  });
  assert.equal(result, null);
});

test("a tag index failure fails the check rather than reporting no update", async () => {
  for (const [body, pattern] of [
    [503, /HTTP 503/],
    [`${pkt("ERR upload-pack: not our ref\n")}`, /refused the tag index: upload-pack: not our ref/],
    [`${pkt("not a ref line\n")}0000`, /invalid tag index/],
    [tagIndex(["v0.1.0-beta.9"]).slice(0, -4), /invalid tag index/],
    [`${tagIndex(["v0.1.0-beta.9"])}0000`, /invalid tag index/]
  ]) {
    await assert.rejects(findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: fetchMap(releases([], ["0.1.0-beta.9"], { [tagIndexUrl]: body })),
      async verifyBundle() { assert.fail("an unreadable index must not be used"); }
    }), pattern);
  }
});

test("pkt-line parsing accepts delimiters only as framing", () => {
  assert.deepEqual(parsePktLines(Buffer.from(`${pkt("one\n")}${pkt("two")}0000`)), ["one", "two"]);
  assert.deepEqual(parsePktLines(Buffer.from("0000")), []);
  for (const bad of ["", "0001", "0004", "000", "zzzz0000", `${pkt("one\n")}`]) {
    assert.throws(() => parsePktLines(Buffer.from(bad)), /invalid tag index/);
  }
});

test("a manifest is not parsed or trusted when signature verification fails", async () => {
  await assert.rejects(
    findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: fetchMap(releases(["v0.1.0-beta.9"], ["0.1.0-beta.9"], {
        [manifestUrl("v0.1.0-beta.9")]: "{not valid json"
      })),
      async verifyBundle() {
        throw new Error("untrusted signer");
      }
    }),
    /untrusted signer/
  );
});

test("a malformed or unreachable release cannot strand the updater when an older signed release is valid", async () => {
  const tags = ["v0.1.0-beta.9", "v0.1.0-beta.10", "v0.1.0-beta.11", "v0.1.0-beta.12"];
  const result = await findLatestRelease({
    channel: "beta",
    trustCacheDirectory: "/tmp/not-used",
    fetchImpl: fetchMap(releases(tags, ["0.1.0-beta.9", "0.1.0-beta.10"], {
      [manifestUrl("v0.1.0-beta.12")]: 503,
      [manifestUrl("v0.1.0-beta.11")]: manifest("0.1.0-beta.11"),
      [bundleUrl("v0.1.0-beta.11")]: 404
    })),
    async verifyBundle(_bundle, payload) {
      if (JSON.parse(payload).version === "0.1.0-beta.10") {
        throw new Error("untrusted signer");
      }
    }
  });
  assert.equal(result.manifest.version, "0.1.0-beta.9");
});

test("signed metadata cannot claim a different GitHub release", async () => {
  const wrong = manifest();
  wrong.release_url =
    "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.10";
  await assert.rejects(
    findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: fetchMap(releases(["v0.1.0-beta.9"], ["0.1.0-beta.9"], { [manifestUrl("v0.1.0-beta.9")]: wrong })),
      async verifyBundle() {}
    }),
    /does not match its release page/
  );
});

test("signed metadata cannot be served under another release's tag", async () => {
  await assert.rejects(
    findLatestRelease({
      channel: "beta",
      trustCacheDirectory: "/tmp/not-used",
      fetchImpl: fetchMap(releases(["v0.1.0-beta.10"], [], {
        [manifestUrl("v0.1.0-beta.10")]: manifest("0.1.0-beta.9"),
        [bundleUrl("v0.1.0-beta.10")]: {}
      })),
      async verifyBundle() {}
    }),
    /does not match its release tag/
  );
});

test("an oversized tag index is rejected before parsing", async () => {
  const declared = new Response("0000", {
    status: 200,
    headers: { "content-length": String(2 * 1024 * 1024) }
  });
  const streamed = new Response("0".repeat(1024 * 1024 + 1));
  for (const response of [declared, streamed]) {
    Object.defineProperty(response, "url", { value: tagIndexUrl });
    await assert.rejects(
      findLatestRelease({
        channel: "beta",
        trustCacheDirectory: "/tmp/not-used",
        fetchImpl: async () => response,
        async verifyBundle() { assert.fail("oversized index must not be used"); }
      }),
      /size limit/
    );
  }
});

test("a threshold failure is classified as a recoverable trust-cache error", () => {
  const error = new Error("outer", {
    cause: new Error("root was signed by 0/3 keys")
  });
  assert.equal(isRecoverableTrustCacheError(error), true);
  assert.equal(isRecoverableTrustCacheError(new Error("untrusted release signer")), false);
});

test("successful fresh verification atomically replaces a stale trust cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-trust-"));
  const cache = join(directory, "sigstore");
  await mkdir(cache);
  await writeFile(join(cache, "root.json"), "stale");
  const calls = [];

  await recoverTrustCache(cache, async (candidate) => {
    calls.push(candidate);
    await mkdir(candidate);
    await writeFile(join(candidate, "root.json"), "fresh");
  }, new Error("root was signed by 0/3 keys"));

  assert.equal(calls.length, 1);
  assert.equal(await readFile(join(cache, "root.json"), "utf8"), "fresh");
});

test("failed fresh verification preserves the existing trust cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-trust-"));
  const cache = join(directory, "sigstore");
  await mkdir(cache);
  await writeFile(join(cache, "root.json"), "stale");

  await assert.rejects(
    recoverTrustCache(cache, async (candidate) => {
      await mkdir(candidate);
      throw new Error("fresh verification failed");
    }, new Error("root was signed by 0/3 keys")),
    /cached and freshly bootstrapped/
  );
  assert.equal(await readFile(join(cache, "root.json"), "utf8"), "stale");
});
