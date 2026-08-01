import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodeMirrorBlobStore,
  NodeMirrorFileSystem
} from "./node.js";

const utf8 = new TextEncoder();

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: number[] = [];
  for await (const chunk of source) chunks.push(...chunk);
  return new Uint8Array(chunks);
}

describe("Node collection file adapters", () => {
  it("atomically writes and hashes binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-node-files-"));
    try {
      const fileSystem = new NodeMirrorFileSystem(root);
      const bytes = utf8.encode("first binary value");
      await fileSystem.writeBinary("media/value.bin", (async function* () {
        yield bytes.slice(0, 4);
        yield bytes.slice(4);
      })());

      expect(new Uint8Array(await readFile(join(root, "media/value.bin")))).toEqual(bytes);
      expect(await fileSystem.inspectBinary("media/value.bin")).toEqual({
        size: bytes.byteLength,
        content_digest: digest(bytes)
      });

      await expect(fileSystem.writeBinary("media/value.bin", (async function* () {
        yield utf8.encode("partial replacement");
        throw new Error("injected stream failure");
      })())).rejects.toThrow("injected stream failure");
      expect(new Uint8Array(await readFile(join(root, "media/value.bin")))).toEqual(bytes);
      expect((await readdir(join(root, "media"))).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses binary writes through symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-node-files-"));
    const outside = await mkdtemp(join(tmpdir(), "mdbase-node-outside-"));
    try {
      await writeFile(join(outside, "private.bin"), "private");
      await symlink(join(outside, "private.bin"), join(root, "linked.bin"));
      const fileSystem = new NodeMirrorFileSystem(root);
      await expect(fileSystem.writeBinary("linked.bin", (async function* () {
        yield utf8.encode("overwrite");
      })())).rejects.toMatchObject({ code: "symlink_denied" });
      expect(await readFile(join(outside, "private.bin"), "utf8")).toBe("private");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps the digest cache outside the collection and streams it back", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-node-files-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "mdbase-node-state-"));
    try {
      const bytes = new Uint8Array(256 * 1024 + 7).map((_, index) => index % 253);
      const contentDigest = digest(bytes);
      const blobStore = new NodeMirrorBlobStore(root, stateRoot);
      await blobStore.write(contentDigest, (async function* () {
        for (let offset = 0; offset < bytes.byteLength; offset += 32 * 1024) {
          yield bytes.slice(offset, offset + 32 * 1024);
        }
      })());

      expect(await blobStore.has(contentDigest)).toBe(true);
      expect(await collect(blobStore.read(contentDigest))).toEqual(bytes);
      const staleDigest = `sha256:${"00".repeat(32)}` as const;
      await blobStore.write(staleDigest, (async function* () {
        yield new Uint8Array([1, 2, 3]);
      })());
      await blobStore.prune(new Set([contentDigest]));
      expect(await blobStore.has(contentDigest)).toBe(true);
      expect(await blobStore.has(staleDigest)).toBe(false);
      expect(await readdir(root)).toEqual([]);
      expect((await readdir(stateRoot, { recursive: true })).some((name) =>
        String(name).includes(contentDigest.slice("sha256:".length))
      )).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("excludes hidden and reserved trees from discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-node-files-"));
    try {
      await mkdir(join(root, ".obsidian"), { recursive: true });
      await mkdir(join(root, "visible", ".cache"), { recursive: true });
      await mkdir(join(root, "node_modules", "package"), { recursive: true });
      await mkdir(join(root, "visible"), { recursive: true });
      await writeFile(join(root, ".secret.bin"), "secret");
      await writeFile(join(root, ".obsidian", "workspace.json"), "private");
      await writeFile(join(root, "visible", ".cache", "thumb.png"), "private");
      await writeFile(join(root, "node_modules", "package", "asset.bin"), "private");
      await writeFile(join(root, "visible", "photo.png"), "visible");
      await writeFile(join(root, "visible", "note.md"), "visible");
      const fileSystem = new NodeMirrorFileSystem(root);

      expect(await fileSystem.listBinary(new Set())).toEqual(["visible/photo.png"]);
      expect(await fileSystem.listMarkdown(new Set())).toEqual(["visible/note.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to hash or stream hard-linked binary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-node-files-"));
    try {
      await writeFile(join(root, "source.bin"), "shared bytes");
      await link(join(root, "source.bin"), join(root, "alias.bin"));
      const fileSystem = new NodeMirrorFileSystem(root);

      await expect(fileSystem.inspectBinary("source.bin")).rejects.toMatchObject({ code: "invalid_path" });
      await expect(fileSystem.readBinary("alias.bin")).rejects.toMatchObject({ code: "invalid_path" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
