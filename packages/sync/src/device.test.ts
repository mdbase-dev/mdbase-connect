import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertHostedMirror,
  clearHostedMirrorMarker,
  loadAuthorityPromotionCheckpoint,
  loadHostedMirrorMarker,
  loadMirrorProfile,
  markHostedMirror,
  mirrorProfileDirectory,
  restoreCollectionConfiguration,
  retireMirrorAfterPromotion,
  saveAuthorityPromotionCheckpoint,
  saveMirrorProfile,
  setHostedCollectionIdentity
} from "./device.js";
import {
  mirrorDeviceDirectory,
  mirrorLeaseDirectory,
  NodeMirrorLease,
  NodeMirrorStateStore
} from "./node.js";

describe("device-local mirror storage", () => {
  it("marks a hosted mirror without putting device role state in hosted resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const collectionId = crypto.randomUUID();
    try {
      await writeFile(join(root, "mdbase.yaml"), "spec_version: 0.3.0\n");
      await markHostedMirror(root, collectionId);
      await assertHostedMirror(root, collectionId);
      expect(await loadHostedMirrorMarker(root)).toEqual({
        version: 1,
        role: "hosted_mirror",
        collection_id: collectionId
      });
      expect(await readFile(join(root, "mdbase.yaml"), "utf8"))
        .toBe("spec_version: 0.3.0\n");
      await expect(markHostedMirror(root, crypto.randomUUID()))
        .rejects.toMatchObject({ code: "hosted_mirror_identity_conflict" });
      await clearHostedMirrorMarker(root, collectionId);
      expect(await loadHostedMirrorMarker(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an authority transfer before a local collection folder becomes a hosted mirror", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    try {
      await writeFile(
        join(root, "mdbase.yaml"),
        `spec_version: 0.3.0\nx-mdbase-connect:\n  collection_id: ${crypto.randomUUID()}\n`
      );
      await expect(markHostedMirror(root, crypto.randomUUID()))
        .rejects.toMatchObject({ code: "local_authority_requires_transfer" });
      expect(await loadHostedMirrorMarker(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("allows only one mirror process to own a physical folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const firstStateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-a-"));
    const secondStateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-b-"));
    const leaseDirectory = await mirrorLeaseDirectory(root);
    try {
      expect(await mirrorDeviceDirectory(root, firstStateRoot))
        .not.toBe(await mirrorDeviceDirectory(root, secondStateRoot));
      const first = new NodeMirrorLease(root);
      const second = new NodeMirrorLease(root);
      const acquired = await first.acquire();
      await expect(second.acquire())
        .rejects.toMatchObject({ code: "mirror_folder_in_use" });
      await acquired.release();
      const reacquired = await second.acquire();
      await reacquired.release();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(firstStateRoot, { recursive: true, force: true });
      await rm(secondStateRoot, { recursive: true, force: true });
      await rm(leaseDirectory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses one lease for aliases of the same physical folder",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "mdbase-mirror-parent-"));
      const root = join(parent, "mirror");
      const alias = join(parent, "mirror-alias");
      let leaseDirectory: string | null = null;
      try {
        await mkdir(root);
        await symlink(root, alias, "dir");
        leaseDirectory = await mirrorLeaseDirectory(root);
        const acquired = await new NodeMirrorLease(root).acquire();
        await expect(new NodeMirrorLease(alias).acquire())
          .rejects.toMatchObject({ code: "mirror_folder_in_use" });
        await acquired.release();
      } finally {
        await rm(parent, { recursive: true, force: true });
        if (leaseDirectory) await rm(leaseDirectory, { recursive: true, force: true });
      }
    }
  );

  it("recovers a lease left behind by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const directory = await mirrorLeaseDirectory(root);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "mirror.lock"), JSON.stringify({
        version: 1,
        owner_id: crypto.randomUUID(),
        pid: 999_999_999,
        acquired_at: new Date().toISOString()
      }));
      const acquired = await new NodeMirrorLease(root).acquire();
      await acquired.release();
      await expect(access(join(directory, "mirror.lock")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the hosted mirror marker is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    try {
      await mkdir(join(root, ".mdbase"));
      await writeFile(join(root, ".mdbase", "connect-role.json"), "{broken");
      await expect(loadHostedMirrorMarker(root))
        .rejects.toMatchObject({ code: "invalid_hosted_mirror_marker" });
      await expect(markHostedMirror(root, crypto.randomUUID()))
        .rejects.toMatchObject({ code: "invalid_hosted_mirror_marker" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked hosted mirror marker",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
      const outside = await mkdtemp(join(tmpdir(), "mdbase-mirror-outside-"));
      try {
        await mkdir(join(root, ".mdbase"));
        const target = join(outside, "connect-role.json");
        await writeFile(target, JSON.stringify({
          version: 1,
          role: "hosted_mirror",
          collection_id: crypto.randomUUID()
        }));
        await symlink(target, join(root, ".mdbase", "connect-role.json"));
        await expect(loadHostedMirrorMarker(root))
          .rejects.toMatchObject({ code: "unsafe_hosted_mirror_marker" });
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    }
  );

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

  it("does not load obsolete in-collection mirror credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-mirror-folder-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-mirror-device-"));
    try {
      const metadata = join(root, ".mdbase");
      await mkdir(metadata, { recursive: true });
      await writeFile(join(metadata, "connect-mirror.json"), JSON.stringify({
        protocol_version: 1,
        provider_url: "https://sync.example",
        collection_id: crypto.randomUUID(),
        replica_id: crypto.randomUUID(),
        replica_token: "legacy-secret",
        mode: "read_write"
      }));

      await expect(loadMirrorProfile(root, stateRoot)).rejects.toMatchObject({
        code: "mirror_not_configured"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
