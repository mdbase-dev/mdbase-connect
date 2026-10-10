import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MdbaseError,
  applyTypePack,
  assessTypePack,
  checkQuery,
  contractDigest,
  getType,
  implementationDigest,
  info,
  init,
  loadCatalog,
  loadPack,
  parseLock,
  validateRecord,
  validateSchema,
} from "../src/index.js";

const SPEC = new URL("../../../conformance/spec/", import.meta.url);
const spec = (p: string) => readFileSync(new URL(p, SPEC), "utf8");
const EX = "examples/v0.3/tasknotes-migration/v0.3/";
const CONTRACT = spec(`${EX}_contracts/tasknotes.task.md`);
const TYPE = spec(`${EX}_types/task.md`);
const CONFIG = 'spec_version: "0.3.0"\nsettings:\n  validation: error\n';

describe("engine", () => {
  it("loads from the package by default and reports its versions", async () => {
    const i = await info();
    expect(i.abi).toBe(1);
    expect(i.spec_versions).toContain("0.3.0");
    expect(i.sem.length).toBe(2);
  });

  it("init accepts explicit bytes and refuses a foreign module", async () => {
    const bytes = readFileSync(new URL("../wasm/mdbase-core.wasm", import.meta.url));
    await init({ wasm: bytes });
    expect((await info()).abi).toBe(1);
    // A minimal valid module with no exports.
    const empty = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    await expect(init({ wasm: empty })).rejects.toMatchObject({ code: "wasm_incompatible" });
    await init({ wasm: bytes });
  });
});

describe("digests", () => {
  it("contract digest equals the spec fixture", async () => {
    const c = await contractDigest(CONTRACT);
    expect(c.digest).toBe("sha256:a49d25136bf3024e146017771d068cdf59abfddbcdd1bfbf8010018c7f13f476");
    expect(c.id).toBe("tasknotes.task");
    expect(c.version).toBe("0.2.0");
    expect(Object.keys(c.schemas)).toEqual(["binding_schema", "record_schema"]);
  });

  it("implementation digest equals the spec fixture", async () => {
    const i = await implementationDigest({ contract: { source: CONTRACT }, type: { source: TYPE } });
    expect(i.digest).toBe("sha256:b994d1fdbc6e7a787393e033520afbcfbe6b715ae87ab62a09e24981811c4730");
    expect(i.type).toBe("task");
  });

  it("accepts a frontmatter object", async () => {
    const c = await contractDigest({
      frontmatter: {
        kind: "mdbase.contract",
        contract_type: "record",
        id: "example.note",
        version: "1.0.0",
        record_schema: { dialect: "json-schema-2020-12", value: { type: "object" } },
      },
    });
    expect(c.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("explains an invalid contract", async () => {
    const e = await contractDigest("---\nkind: nope\n---\n").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MdbaseError);
    const err = e as MdbaseError;
    expect(err.code).toBe("invalid_data_contract");
    expect(err.help).toMatch(/mdbase\.contract/);
    expect(err.message.length).toBeGreaterThan(10);
  });
});

describe("catalog and validation", () => {
  const resources = { "mdbase.yaml": CONFIG, "_types/task.md": TYPE, "_contracts/tasknotes.task.md": CONTRACT };

  it("loads config, types, contracts and implementations", async () => {
    const cat = await loadCatalog(resources);
    expect(cat.valid).toBe(true);
    expect(cat.spec_version).toBe("0.3.0");
    expect(cat.settings.validation).toBe("error");
    expect(cat.types.map((t) => t.name)).toEqual(["task"]);
    expect(cat.implementations[0]?.contract).toBe("tasknotes.task");
    expect((await getType(resources, "task"))?.raw["name"]).toBe("task");
    expect(await getType(resources, "nope")).toBeUndefined();
  });

  it("reports invalid config without throwing", async () => {
    const cat = await loadCatalog({ "mdbase.yaml": "spec_version: 9.9.9\n" });
    expect(cat.valid).toBe(false);
    expect(cat.issues[0]?.code).toBeTruthy();
  });

  it("validates a record against its type", async () => {
    const good = await validateRecord({
      resources,
      path: "tasks/a.md",
      source: "---\ntype: task\ntitle: Hi\nstatus: open\ndateCreated: 2026-01-01T00:00:00Z\n---\n",
    });
    expect(good.types).toEqual(["task"]);
    expect(good.issues.filter((i) => i.severity === "error")).toEqual([]);
    const bad = await validateRecord({ resources, path: "tasks/b.md", source: "---\ntype: task\ntitle: 1\n---\n" });
    expect(bad.issues.map((i) => i.code)).toContain("schema_required");
  });

  it("validates plain JSON Schema", async () => {
    const schema = { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 } } };
    expect((await validateSchema({ schema, instance: { title: "x" } })).valid).toBe(true);
    const r = await validateSchema({ schema, instance: { title: "" } });
    expect(r.issues[0]).toMatchObject({ code: "schema_min_length", instance_path: "/title" });
    await expect(validateSchema({ schema: { type: "nope" }, instance: 1 })).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("checks queries", async () => {
    expect(await checkQuery({ types: ["task"], where: "status == 'open'" }, resources)).toEqual({ valid: true, types: ["task"] });
    const e = await checkQuery({ typo: 1 }).catch((x: unknown) => x as MdbaseError);
    expect(e).toMatchObject({ code: "invalid_query", location: "typo" });
  });
});

describe("type packs", () => {
  const manifest = spec(`${EX}mdbase-pack.yaml`);
  const pack = {
    manifest,
    sources: { "_contracts/tasknotes.task.md": CONTRACT, "_types/task.md": TYPE },
  };
  const options = { installed_by: "dev.mdbase.test" };

  it("loads, assesses, applies, and is idempotent", async () => {
    const p = await loadPack(pack);
    expect(p.id).toBe("tasknotes.tasks");
    expect(p.resources.length).toBe(2);

    const resources: Record<string, string> = { "mdbase.yaml": CONFIG };
    const a = await assessTypePack({ pack, resources, options });
    expect(a.status).toBe("install");
    expect(a.applicable).toBe(true);
    expect(a.resources.map((r) => r.action)).toEqual(["create", "create"]);

    const r = await applyTypePack({ pack, resources, options, expectedDigest: a.assessment_digest });
    expect(r.writes.map((w) => w.path).sort()).toEqual(["_contracts/tasknotes.task.md", "_types/task.md", "mdbase.lock.yaml"]);
    expect(r.ops).toEqual([
      { kind: "resource_put", path: "_contracts/tasknotes.task.md", doc: CONTRACT, mustNotExist: true },
      { kind: "resource_put", path: "_types/task.md", doc: TYPE, mustNotExist: true },
      { kind: "resource_put", path: "mdbase.lock.yaml", doc: r.assessment.lock_document, mustNotExist: true },
    ]);
    for (const w of r.writes) resources[w.path] = w.document;

    const lock = await parseLock(resources["mdbase.lock.yaml"]!);
    expect(lock.packs[0]?.id).toBe("tasknotes.tasks");
    const current = await assessTypePack({ pack, resources, options });
    expect(current.status).toBe("current");
    const noChange = await applyTypePack({ pack, resources, options, expectedDigest: current.assessment_digest });
    expect(noChange.ops).toEqual([]);
    expect(noChange.writes).toEqual([]);
    expect(noChange.deletes).toEqual([]);
  });

  it("retains core delete and lock CAS guards on upgrade", async () => {
    const revision = (doc: string) => "sha256:" + createHash("sha256").update(doc).digest("hex");
    const resources: Record<string, string> = { "mdbase.yaml": CONFIG };
    const a = await assessTypePack({ pack, resources, options });
    const installed = await applyTypePack({ pack, resources, options, expectedDigest: a.assessment_digest });
    for (const w of installed.writes) resources[w.path] = w.document;
    const upgradePack = { ...pack, manifest: manifest.split("  - kind: type")[0]!.replace("version: 0.2.0", "version: 0.3.0") };
    const upgrade = await assessTypePack({ pack: upgradePack, resources, options });
    expect(upgrade.status).toBe("upgrade");
    const result = await applyTypePack({ pack: upgradePack, resources, options, expectedDigest: upgrade.assessment_digest });
    expect(result.ops).toEqual([
      { kind: "resource_delete", path: "_types/task.md", baseRevision: revision(TYPE) },
      { kind: "resource_put", path: "mdbase.lock.yaml", doc: result.assessment.lock_document, baseRevision: revision(resources["mdbase.lock.yaml"]!), mustNotExist: false },
    ]);
    expect(result.deletes).toEqual(["_types/task.md"]);
    expect(result.writes).toEqual([{ path: "mdbase.lock.yaml", document: result.assessment.lock_document }]);
  });

  it("refuses a stale assessment", async () => {
    const e = await applyTypePack({
      pack,
      resources: { "mdbase.yaml": CONFIG },
      options,
      expectedDigest: "sha256:" + "0".repeat(64),
    }).catch((x: unknown) => x as MdbaseError);
    expect(e).toMatchObject({ code: "concurrent_modification" });
    expect((e as MdbaseError).help).toMatch(/assessTypePack/);
  });
});
