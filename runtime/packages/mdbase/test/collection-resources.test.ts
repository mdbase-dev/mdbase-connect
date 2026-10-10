import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyCollectionResources,
  assessCollectionResources,
  loadCatalog,
  parseLock,
  type CollectionSetup,
  type ResourceSource,
} from "../src/index.js";

const hash = (source: string) => "sha256:" + createHash("sha256").update(source).digest("hex");
const setup = (): CollectionSetup => ({
  application_id: "app.reader",
  declaration_digest: hash("declaration"),
  requirements: { configuration: [{ id: "base-extension", path: "/settings/record_extensions", predicate: "contains", value: "base" }] },
  provisions: { configuration: [{ requirement: "base-extension", path: "/settings/record_extensions", operation: "set_add", value: "base" }] },
});
function pack(name: string) {
  const document = `---\nkind: mdbase.type\nname: ${name}\nschema:\n  dialect: json-schema-2020-12\n  value: {type: object}\n---\n`;
  return {
    provision: {
      manifest: `kind: mdbase.type-pack\nid: example.${name}\nversion: 1.0.0\nresources:\n  - kind: type\n    mode: managed\n    source: type.md\n    target: _types/${name}.md\n    digest: ${hash(document)}\n`,
      sources: { "type.md": document },
    },
    options: { installed_by: "app.reader" },
  };
}

describe("resource-only collection components through actual WASM", () => {
  it("returns detailed evidence and original config CAS, not head/file authority", async () => {
    const source = "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, txt]\nx-user: keep\n";
    const resources = [{ path: "mdbase.yaml", source }];
    const declaration = setup();
    const a = await assessCollectionResources({ resources, setup: declaration });
    expect(a.scope).toBe("resources");
    for (const field of ["collection_revision", "files", "file_absence", "writable"]) expect(a).not.toHaveProperty(field);
    expect(a.configuration.configuration[0]).toMatchObject({ action: "add", value: "base", conflict: null });
    expect(a.configuration.source_digest).toBe(hash(source));
    expect(a.configuration.document).toContain("x-user: keep");
    const r = await applyCollectionResources({ resources, setup: declaration, expectedDigest: a.assessment_digest });
    expect(r.assessment).toEqual(a);
    expect(r.ops[0]).toMatchObject({ kind: "resource_put", path: "mdbase.yaml", baseRevision: hash(source), mustNotExist: false });
    expect(r).not.toHaveProperty("writes");
    const catalog = await loadCatalog({ "mdbase.yaml": a.configuration.document! });
    expect(catalog.settings.record_extensions).toEqual(["md", "txt", "base"]);
  });

  it("strictly loads two packs and retains one Core combined lock with absence guard", async () => {
    const declaration = setup();
    declaration.provisions!.type_packs = [pack("one"), pack("two")];
    const a = await assessCollectionResources({ resources: [], setup: declaration });
    expect(a.type_packs.map((p) => p.status)).toEqual(["install", "install"]);
    expect(a.type_packs[0]!.resources[0]!.document).toContain("name: one");
    const r = await applyCollectionResources({ resources: [], setup: declaration, expectedDigest: a.assessment_digest });
    const locks = r.ops.filter((op) => op.kind === "resource_put" && op.path === "mdbase.lock.yaml");
    expect(locks).toHaveLength(1);
    const lock = locks[0]!;
    expect(lock.kind).toBe("resource_put");
    if (lock.kind !== "resource_put") throw new Error("expected original Core lock put");
    expect(lock.mustNotExist).toBe(true);
    expect(lock).not.toHaveProperty("baseRevision");
    expect((await parseLock(lock.doc)).packs.map((p) => p.id)).toEqual(["example.one", "example.two"]);
    // DATA-only materialization for reassessment, not execution qualification.
    const installed: ResourceSource[] = r.ops.map((op) => {
      if (op.kind !== "resource_put") throw new Error("unexpected delete in first install");
      return { path: op.path, source: op.doc };
    });
    const current = await assessCollectionResources({ resources: installed, setup: declaration });
    expect(current.applicable).toBe(true);
    expect(current.type_packs.map((p) => p.status)).toEqual(["current", "current"]);
    expect((await applyCollectionResources({ resources: installed, setup: declaration, expectedDigest: current.assessment_digest })).ops).toEqual([]);
  });

  it("fails stale data/declaration without fallback and never returns conflict ops", async () => {
    const declaration = setup();
    const a = await assessCollectionResources({ resources: [], setup: declaration });
    await expect(applyCollectionResources({ resources: [{ path: "_types/other.md", source: "changed" }], setup: declaration, expectedDigest: a.assessment_digest })).rejects.toMatchObject({ code: "concurrent_modification" });
    await expect(applyCollectionResources({ resources: [], setup: { ...declaration, declaration_digest: hash("changed") }, expectedDigest: a.assessment_digest })).rejects.toMatchObject({ code: "concurrent_modification" });
    const resources = [{ path: "mdbase.yaml", source: "settings:\n  record_extensions: bad\n" }];
    const conflict = await assessCollectionResources({ resources, setup: declaration });
    expect(conflict.applicable).toBe(false);
    expect(conflict.configuration.configuration[0]!.conflict!.observed).toBe("string");
    await expect(applyCollectionResources({ resources, setup: declaration, expectedDigest: conflict.assessment_digest })).rejects.toMatchObject({ code: "collection_setup_conflict" });
  });

  it("rejects missing/null/object/duplicate inventory through the JS boundary", async () => {
    const badInputs: unknown[] = [
      { setup: setup() }, { setup: setup(), resources: null }, { setup: setup(), resources: {} },
      { setup: setup(), resources: [{ path: "a", source: "x" }, { path: "a", source: "y" }] },
    ];
    for (const input of badInputs) {
      await expect(assessCollectionResources(input as Parameters<typeof assessCollectionResources>[0])).rejects.toMatchObject({ code: "invalid_collection_setup" });
    }
  });
});
