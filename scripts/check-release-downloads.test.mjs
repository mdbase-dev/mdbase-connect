import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkReleaseDownloads } from "./check-release-downloads.mjs";

async function fixture(context, path, content) {
  const root = await mkdtemp(join(tmpdir(), "release-guard-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, dirname(path)), { recursive: true });
  await writeFile(join(root, path), content);
  return root;
}

for (const command of ["curl -fL", "wget", "await fetch("]) test(`rejects new direct release fetches: ${command}`, async context => {
  const url = "https://github.com/owner/repo/releases/" + "download/v1/tool";
  const root = await fixture(context, "apps/editor/scripts/release.mjs", `${command} '${url}'`);
  assert.equal((await checkReleaseDownloads(root)).length, 1);
});

test("rejects direct object-host and computed asset URL fetches", async context => {
  const root = await fixture(context, "scripts/release.mjs", "fetch('https://objects." + "githubusercontent.com/file')\nfetch(asset.browser_download_url)");
  assert.equal((await checkReleaseDownloads(root)).length, 2);
});

test("allowlist is exact, documented and expires when the line changes", async context => {
  const path = "scripts/manifest.mjs";
  const line = 'const url = "https://github.com/owner/repo/releases/' + 'download/v1/tool";';
  const root = await fixture(context, path, line);
  await mkdir(join(root, ".github"));
  await writeFile(join(root, ".github/release-download-allowlist.json"), JSON.stringify([{ path, line, reason: "Manifest data, not a request" }]));
  assert.deepEqual(await checkReleaseDownloads(root), []);
  await writeFile(join(root, path), `fetch(${line.slice(12, -1)})`);
  assert.equal((await checkReleaseDownloads(root)).length, 2);
});

test("guards step-scoped CLI, publisher, Buildx and Java transports", async context => {
  const root = await fixture(context, ".github/workflows/release.yml", [
    "jobs:", "  build:", "    steps:",
    "      - run: node scripts/publisher/build.mjs temp",
    "      - run: gh release download v1",
    "      - uses: docker/setup-buildx-action@sha",
    "      - uses: actions/setup-java@v5", "        with:", "          distribution: temurin",
  ].join("\n"));
  assert.equal((await checkReleaseDownloads(root)).length, 4);
  await writeFile(join(root, ".github/workflows/release.yml"), [
    "jobs:", "  build:", "    steps:",
    "      - run: node scripts/publisher/build.mjs temp", "        env:", "          GITHUB_TOKEN: ${{ github.token }}",
    "      - run: gh release download v1", "        env:", "          GH_TOKEN: ${{ github.token }}",
    "      - uses: docker/setup-buildx-action@sha", "        env:", "          GITHUB_TOKEN: token ${{ github.token }}",
    "      - uses: actions/setup-java@v5", "        with:", "          distribution: jdkfile",
  ].join("\n"));
  assert.deepEqual(await checkReleaseDownloads(root), []);
});

test("does not treat test fixtures or npm registry intake as release fetches", async context => {
  const root = await fixture(context, "scripts/publisher/intake.test.mjs", "fetch(asset.browser_download_url)");
  await writeFile(join(root, "scripts/publisher/intake.mjs"), "fetch('https://registry.npmjs.org/package')");
  assert.deepEqual(await checkReleaseDownloads(root), []);
});


test("worker-build cannot lose its authenticated prefetch", async context => {
  const path = ".github/workflows/workers.yml";
  const root = await fixture(context, path, "jobs:\n  build:\n    steps:\n      - run: worker-build --release --locked");
  assert.equal((await checkReleaseDownloads(root)).length, 1);
  await writeFile(join(root, path), [
    "jobs:", "  build:", "    steps:",
    "      - run: node scripts/ci/prefetch-worker-tools.mjs .", "        env:", "          GITHUB_TOKEN: ${{ github.token }}",
    "      - run: worker-build --release --locked",
  ].join("\n"));
  assert.deepEqual(await checkReleaseDownloads(root), []);
});
