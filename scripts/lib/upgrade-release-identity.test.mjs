import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const beta95 = "408c67bc10f128e0833f0da62cb3efb9d94657d7";
const beta97 = "b34ba70fd0a13d13b42d5de20f29dd04d5582272";
const release95 = { id: 95, tag_name: "v0.1.0-beta.95", draft: false, published_at: "2026-09-08T00:00:00Z" };
const release97 = { ...release95, id: 97, tag_name: "v0.1.0-beta.97" };
const annotated = (tag, commit) => `${"a".repeat(40)}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`;

async function verify(context, { historical = false, metadata, refs, override = "", network = "ok", image = false, inspection } = {}) {
  const work = await mkdtemp(join(tmpdir(), "upgrade-release-identity-"));
  context.after(() => rm(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  await mkdir(bin);
  const scripts = {
    curl: `#!/usr/bin/env bash
set -euo pipefail
url=\"\${@: -1}\"
printf 'curl %s\\n' \"$url\" >> \"$CALLS\"
[[ $url == \"$EXPECTED_URL\" && $NETWORK == ok ]] || exit 22
printf '%s' \"$METADATA\"
`,
    git: `#!/usr/bin/env bash
set -euo pipefail
printf 'git\\n' >> \"$CALLS\"
[[ $* == \"-C $ROOT ls-remote --exit-code --tags origin refs/tags/$TAG refs/tags/$TAG^{}\" ]] || exit 23
printf '%s' \"$REFS\"
`,
    docker: `#!/usr/bin/env bash
set -euo pipefail
printf 'docker\\n' >> \"$CALLS\"
[[ $1 == image && $2 == inspect ]] || exit 24
printf '%s' \"$INSPECTION\"
`
  };
  for (const [name, content] of Object.entries(scripts)) await writeFile(join(bin, name), content, { mode: 0o700 });
  const tag = historical ? release95.tag_name : release97.tag_name;
  const commit = historical ? beta95 : beta97;
  const calls = join(work, "calls");
  const pin = historical ? "retained-v2-predecessor.env" : "previous-release.env";
  const verifier = historical ? "upgrade_verify_retained_v2_release" : "upgrade_verify_previous_release";
  let code = 0;
  let stderr = "";
  try {
    await execute("/usr/bin/bash", ["-euo", "pipefail", "-c", `
source "$ROOT/.github/${pin}"
source "$ROOT/test/upgrade/lib.sh"
${override}
${image ? 'upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE"' : `${verifier} "$ROOT"`}
`], {
      timeout: 5000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: work, LANG: "C", ROOT: root, CALLS: calls,
        TAG: tag, NETWORK: network,
        EXPECTED_URL: historical
          ? "https://api.github.com/repos/mdbase-dev/mdbase-connect/releases/tags/v0.1.0-beta.95"
          : "https://api.github.com/repos/mdbase-dev/mdbase-connect/releases?per_page=100",
        METADATA: typeof metadata === "string" ? metadata : JSON.stringify(metadata ?? (historical ? release95 : [release97, release95])),
        REFS: refs ?? annotated(tag, commit),
        INSPECTION: JSON.stringify(inspection ?? [{ Config: { Labels: {
          "org.opencontainers.image.source": "https://github.com/mdbase-dev/mdbase-connect",
          "org.opencontainers.image.revision": commit
        } } }])
      }
    });
  } catch (error) {
    if (error.killed || typeof error.code !== "number") throw error;
    code = error.code;
    stderr = error.stderr;
  }
  return { code, stderr, calls: await readFile(calls, "utf8").catch(() => "") };
}

test("ordinary predecessor verifies newest beta97 and its annotated origin tag", async (context) => {
  const result = await verify(context);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.calls, /releases\?per_page=100\ngit\n$/);
});

test("ordinary qualification cannot substitute the historical beta95 pin for newest beta97", async (context) => {
  const result = await verify(context, { override: 'source "$ROOT/.github/retained-v2-predecessor.env"' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not the unique newest non-draft/);
  assert.doesNotMatch(result.calls, /^git$/m);
});

for (const [name, metadata] of [
  ["older pin", [release95, release97]],
  ["duplicate release", [release97, release97]],
  ["draft only", [{ ...release97, draft: true }]],
  ["missing release", []],
  ["object instead of inventory", release97],
  ["malformed JSON", "not-json"]
]) test(`ordinary predecessor rejects ${name}`, async (context) => {
  const result = await verify(context, { metadata });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.calls, /^git$/m);
});

for (const historical of [false, true]) {
  const tag = historical ? release95.tag_name : release97.tag_name;
  const commit = historical ? beta95 : beta97;
  for (const [name, refs] of [
    ["wrong peeled commit", annotated(tag, "b".repeat(40))],
    ["lightweight tag", `${commit}\trefs/tags/${tag}\n`],
    ["duplicate peeled ref", annotated(tag, commit) + `${commit}\trefs/tags/${tag}^{}\n`],
    ["foreign ref", annotated(tag, commit) + `${commit}\trefs/heads/main\n`],
    ["malformed ref hash", `bad\trefs/tags/${tag}\n`]
  ]) test(`${historical ? "historical" : "ordinary"} rejects ${name}`, async (context) => {
    const result = await verify(context, { historical, refs });
    assert.notEqual(result.code, 0);
    assert.match(result.calls, /^git$/m);
  });
  test(`${historical ? "historical" : "ordinary"} fails closed on release GET failure`, async (context) => {
    const result = await verify(context, { historical, network: "failed" });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.calls, /^git$/m);
  });
}

test("historical regression verifies published beta95 by exact tag, independently of newest release", async (context) => {
  const result = await verify(context, { historical: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.calls, /releases\/tags\/v0\.1\.0-beta\.95\ngit\n$/);
});

for (const metadata of [
  { ...release95, draft: true }, { ...release95, tag_name: release97.tag_name },
  { ...release95, published_at: null }, { ...release95, published_at: "" },
  { ...release95, id: "95" }, [release95], {}, "not-json"
]) test(`historical rejects unqualified release metadata ${JSON.stringify(metadata)}`, async (context) => {
  const result = await verify(context, { historical: true, metadata });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.calls, /^git$/m);
});

for (const variable of ["RELEASE", "RELEASE_COMMIT", "SERVER_IMAGE", "PROVIDER_IMAGE"]) {
  test(`historical rejects altered ${variable} before network`, async (context) => {
    const result = await verify(context, { historical: true, override: `MDBASE_CONNECT_PREVIOUS_${variable}=changed` });
    assert.equal(result.code, 2);
    assert.equal(result.calls, "");
  });
}
for (const variable of ["RELEASE", "RELEASE_COMMIT"]) {
  test(`ordinary rejects malformed ${variable} before network`, async (context) => {
    const result = await verify(context, { override: `MDBASE_CONNECT_PREVIOUS_${variable}=bad/path` });
    assert.equal(result.code, 2);
    assert.equal(result.calls, "");
  });
}

test("pulled image must still identify the exact predecessor source and revision", async (context) => {
  assert.equal((await verify(context, { image: true })).code, 0);
  for (const inspection of [[], [{ Config: { Labels: {} } }], [{ Config: { Labels: {
    "org.opencontainers.image.source": "https://github.com/mdbase-dev/mdbase-connect",
    "org.opencontainers.image.revision": beta95
  } } }]]) assert.notEqual((await verify(context, { image: true, inspection })).code, 0);
});
