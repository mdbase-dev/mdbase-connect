import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadAuthorityPromotionCheckpoint,
  loadMirrorProfile,
  mirrorProfileDirectory,
  restoreCollectionConfiguration,
  retireMirrorAfterPromotion,
  saveAuthorityPromotionCheckpoint,
  saveMirrorProfile,
  setHostedCollectionIdentity
} from "./device.js";
import { NodeMirrorStateStore, type MirrorState } from "./node.js";

describe("device-local mirror storage", () => {
  it("sets the hosted identity atomically and can restore the original collection config", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const collectionId = crypto.randomUUID();
    const original = "spec_version: 0.3.0\nname: Promoted\n";
    try {
      await writeFile(join(root, "mdbase.yaml"), original);
      const saved = await setHostedCollectionIdentity(root, collectionId);
      expect(saved).toBe(original);
      expect(await readFile(join(root, "mdbase.yaml"), "utf8")).toContain(
        `collection_id: ${collectionId}`
      );
      await setHostedCollectionIdentity(root, collectionId);
      await expect(setHostedCollectionIdentity(root, crypto.randomUUID()))
        .rejects.toMatchObject({ code: "collection_identity_conflict" });
      await restoreCollectionConfiguration(root, saved);
      expect(await readFile(join(root, "mdbase.yaml"), "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires mirror secrets and leaves only a non-secret authority receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-"));
    const collectionId = crypto.randomUUID();
    try {
      await saveMirrorProfile(
        root,
        {
          version: 1,
          provider_url: "https://sync.example",
          control_url: "https://connect.example",
          collection_id: collectionId,
          replica_id: crypto.randomUUID(),
          mode: "read_write"
        },
        { access_token: "access-secret", refresh_token: "refresh-secret" },
        stateRoot
      );
      await new NodeMirrorStateStore(root, stateRoot).write({
        protocol_version: 1,
        replica_id: crypto.randomUUID(),
        scope_epoch: 1,
        cursor: 3,
        records: {},
        conflicts: {}
      });
      const directory = await mirrorProfileDirectory(root, stateRoot);
      await retireMirrorAfterPromotion(
        root,
        { collection_id: collectionId, authority_epoch: 2 },
        stateRoot
      );
      await expect(readFile(join(directory, "credentials.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(directory, "profile.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(directory, "mirror-state.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      const receipt = JSON.parse(await readFile(join(directory, "authority.json"), "utf8"));
      expect(receipt).toMatchObject({
        version: 1,
        collection_id: collectionId,
        authority_epoch: 2
      });
      expect(JSON.stringify(receipt)).not.toContain("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("persists the proof needed to resume after the hosted provider commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-"));
    const checkpoint = {
      transfer_id: crypto.randomUUID(),
      collection_id: crypto.randomUUID(),
      manifest_digest: "a".repeat(64),
      authority_epoch: 2,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      original_configuration: "spec_version: 0.3.0\n"
    };
    try {
      await saveAuthorityPromotionCheckpoint(root, checkpoint, stateRoot);
      expect(await loadAuthorityPromotionCheckpoint(root, stateRoot)).toEqual({
        version: 1,
        ...checkpoint
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("keeps credentials and replica state outside the synchronized folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-"));
    try {
      await saveMirrorProfile(
        root,
        {
          version: 1,
          provider_url: "https://sync.example",
          control_url: "https://connect.example",
          collection_id: crypto.randomUUID(),
          replica_id: crypto.randomUUID(),
          mode: "read_write"
        },
        { access_token: "access-secret", refresh_token: "refresh-secret" },
        stateRoot
      );
      const stored = await loadMirrorProfile(root, stateRoot);
      expect(stored.credentials).toEqual({
        access_token: "access-secret",
        refresh_token: "refresh-secret"
      });
      const directory = await mirrorProfileDirectory(root, stateRoot);
      if (process.platform !== "win32") {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
      }
      await expect(access(join(root, ".mdbase", "connect-mirror.json"))).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("does not attach an old writable journal to a folder recreated at the same path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mdbase-mirror-parent-"));
    const root = join(parent, "mirror");
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-"));
    try {
      await mkdir(root);
      await saveMirrorProfile(
        root,
        {
          version: 1,
          provider_url: "https://sync.example",
          collection_id: crypto.randomUUID(),
          replica_id: crypto.randomUUID(),
          mode: "read_write"
        },
        { access_token: "access-secret" },
        stateRoot
      );
      const originalDirectory = await mirrorProfileDirectory(root, stateRoot);
      await rm(root, { recursive: true });
      await mkdir(root);
      expect(await mirrorProfileDirectory(root, stateRoot)).not.toBe(originalDirectory);
      await expect(loadMirrorProfile(root, stateRoot)).rejects.toMatchObject({
        code: "mirror_not_configured"
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("rejects a device-state directory inside the synchronized folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    try {
      await expect(mirrorProfileDirectory(root, join(root, ".device-state")))
        .rejects.toMatchObject({ code: "mirror_state_inside_collection" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy tokens, journals, and conflict receipts off the collection", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-"));
    const replicaId = crypto.randomUUID();
    const conflictId = crypto.randomUUID();
    const state: MirrorState = {
      protocol_version: 1,
      replica_id: replicaId,
      scope_epoch: 1,
      cursor: 4,
      records: {},
      conflicts: {
        [conflictId]: {
          mutation_id: crypto.randomUUID(),
          status: "rejected",
          error: { code: "invalid", message: "Needs attention" }
        }
      }
    };
    try {
      const metadata = join(root, ".mdbase");
      await mkdir(join(metadata, "conflicts"), { recursive: true });
      await writeFile(join(metadata, "connect-mirror.json"), JSON.stringify({
        protocol_version: 1,
        provider_url: "https://sync.example",
        collection_id: crypto.randomUUID(),
        replica_id: replicaId,
        replica_token: "legacy-secret",
        mode: "read_write"
      }));
      await writeFile(join(metadata, "connect-sync.json"), JSON.stringify(state));
      await writeFile(join(metadata, "conflicts", `${conflictId}.json`), "{}");

      const migrated = await loadMirrorProfile(root, stateRoot);
      expect(migrated.credentials.access_token).toBe("legacy-secret");
      expect(await new NodeMirrorStateStore(root, stateRoot).read()).toEqual(state);
      await expect(readFile(join(metadata, "connect-mirror.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(metadata, "connect-sync.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(metadata, "conflicts", `${conflictId}.json`), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
