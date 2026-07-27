import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mirrorProfileDirectory } from "@mdbase/connect-sync/device";
import { MirrorManager, pathsOverlap } from "../dist/main/mirror-manager.js";

test("hosted mirrors reject the same folder and nested folders", () => {
  assert.equal(pathsOverlap("/vault/hosted", "/vault/hosted"), true);
  assert.equal(pathsOverlap("/vault/hosted", "/vault/hosted/nested"), true);
  assert.equal(pathsOverlap("/vault/hosted/nested", "/vault/hosted"), true);
});

test("hosted mirrors allow sibling folders with similar names", () => {
  assert.equal(pathsOverlap("/vault/hosted", "/vault/hosted-copy"), false);
  assert.equal(pathsOverlap("/vault/one", "/vault/two"), false);
});

test("a corrupt authority checkpoint is isolated to its mirror summary", async () => {
  const userData = await mkdtemp(join(tmpdir(), "mdbase-desktop-user-data-"));
  const root = await mkdtemp(join(tmpdir(), "mdbase-desktop-mirror-"));
  const manager = new MirrorManager(userData);
  const collectionId = "11111111-1111-4111-8111-111111111111";
  const replicaId = "22222222-2222-4222-8222-222222222222";
  try {
    await writeFile(join(userData, "mirrors.json"), JSON.stringify({
      version: 1,
      mirrors: [{
        collection_id: collectionId,
        replica_id: replicaId,
        name: "Recovery test",
        mode: "read_write",
        path: root,
        created_at: new Date().toISOString()
      }]
    }));
    const profileDirectory = await mirrorProfileDirectory(
      root,
      join(userData, "mirror-state")
    );
    await mkdir(profileDirectory, { recursive: true });
    await writeFile(
      join(profileDirectory, "authority-promotion.json"),
      "{\"version\":1,\"transfer_id\":false}\n"
    );

    const summaries = await manager.list();

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].replica_id, replicaId);
    assert.equal(summaries[0].state, "attention");
    assert.equal(summaries[0].promotion_pending, false);
    assert.match(
      summaries[0].error,
      /Authority transfer recovery data could not be read/
    );
  } finally {
    manager.stop();
    await rm(userData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
