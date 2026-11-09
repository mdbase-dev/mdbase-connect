import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { managedEnvironments } from "../../scripts/lib/managed-environments.mjs";
import { managedAppOrigins } from "../../scripts/lib/managed-app-origins.mjs";
import { checkBuiltAssets } from "../../scripts/ci/check-portal-assets.mjs";

for (const leaking of [false, true]) {
  test(`the Portal asset check ${leaking ? "rejects deployment account identifiers" : "accepts public origins"}`, async () => {
    const directory = await mkdtemp(new URL(".bundle-check-", import.meta.url));
    try {
      await mkdir(`${directory}/assets`);
      const { cloudflareAccountId, connectOrigin } = managedEnvironments.lab;
      await writeFile(`${directory}/assets/portal#bundle.js`, JSON.stringify(leaking ? cloudflareAccountId : connectOrigin));
      const check = checkBuiltAssets(directory);
      if (leaking) {
        await assert.rejects(check, { message: "Portal build contains a deployment account identifier." });
      } else {
        await check;
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("managed app origins contain only public origins shared with deployment tooling", () => {
  const originKeys = ["connectOrigin", "editorOrigin", "journalOrigin", "readerOrigin", "tasknotesOrigin", "writerOrigin"];
  assert.deepEqual(Object.keys(managedAppOrigins).sort(), ["lab", "production", "staging"]);
  for (const [name, origins] of Object.entries(managedAppOrigins)) {
    assert.deepEqual(Object.keys(origins).sort(), originKeys);
    for (const key of originKeys) {
      assert.equal(origins[key], managedEnvironments[name][key]);
      assert.equal(new URL(origins[key]).origin, origins[key]);
    }
  }
});

test("the Portal container build includes public origins and its build-time leak check dependencies", async () => {
  const dockerfile = await readFile(new URL("../../deploy/docker/Dockerfile.server", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY scripts\/lib\/managed-app-origins\.mjs scripts\/lib\/managed-app-origins\.mjs$/mu);
  assert.match(dockerfile, /^COPY scripts\/lib\/managed-environments\.mjs scripts\/lib\/managed-environments\.mjs$/mu);
  assert.match(dockerfile, /^COPY scripts\/ci\/check-portal-assets\.mjs scripts\/ci\/check-portal-assets\.mjs$/mu);
});
