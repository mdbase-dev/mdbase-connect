import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { CollectionDescription } from "@mdbase/connect-protocol";
import {
  DataContractDefinitionError,
  TypePackDefinitionError,
  createSandbox,
  defineDataContract,
  defineTypePack,
  validateAppManifest,
  validateDataContract,
  validateProtocolValue
} from "./index.js";

const taskDescription: Partial<CollectionDescription> = {
  display_name: "Tasks",
  types: [{
    name: "task",
    version: 1,
    schema: { type: "object" },
    collection: { read_defaults: { status: "open" } },
    extensions: {}
  }],
  contracts: [{
    id: "example.work-item",
    version: "1.0.0",
    digest: `sha256:${"0".repeat(64)}`,
    schema: { type: "object" },
    implementations: [{
      type_name: "task",
      type_version: 1,
      digest: `sha256:${"1".repeat(64)}`,
      fields: { title: "title" }
    }]
  }]
};

function taskTypePack(provides = [{ id: "example.work-item", version: "1.0.0" }]) {
  const document = "---\nkind: mdbase.type\nname: task\n---\n";
  return {
    manifest: {
      kind: "mdbase.type-pack",
      id: "example.tasks",
      version: "1.0.0",
      resources: [{
        kind: "type",
        source: "task.md",
        target: "_types/task.md",
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
      }]
    },
    resources: [{ source: "task.md", document }],
    provides
  };
}

describe("canonical developer validation", () => {
  it("validates public application manifests with the packaged schema", () => {
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["https://tasks.example/callback"],
      requirements: { contracts: [{ id: "example.work-item", version: "1.0.0" }] }
    })).toEqual({ valid: true, issues: [] });
    const invalid = validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "http://tasks.example/",
      redirect_uris: []
    });
    expect(invalid.valid).toBe(false);
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "http://localhost:5179",
      redirect_uris: ["http://localhost:5179/callback"]
    }, { allowLocal: true }).valid).toBe(true);
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["https://attacker.example/callback"]
    }).valid).toBe(false);
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["example.tasks.desktop://auth/mdbase/callback"]
    }).valid).toBe(true);
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["com.attacker.desktop://auth/mdbase/callback"]
    }).valid).toBe(false);
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["https://tasks.example/callback"],
      requirements: { contracts: [{ id: "example.work-item", version: "1.0.0" }] },
      provisions: {
        type_packs: [taskTypePack()]
      }
    }).valid).toBe(true);
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["https://tasks.example/callback"],
      requirements: { contracts: [{ id: "example.work-item", version: "1.0.0" }] },
      provisions: {
        type_packs: [taskTypePack([{ id: "other.contract", version: "1.0.0" }])]
      }
    }).valid).toBe(false);
  });

  it("validates bundled v1 manifests with auxiliary provisioned types", () => {
    const manifest = {
      manifest_version: 1,
      id: "dev.mdbase.tasks",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: [
        "https://tasks.example/callback",
        "dev.mdbase.tasks://auth/mdbase/callback"
      ],
      requirements: { contracts: [{ id: "example.work-item", version: "1.0.0" }] },
      provisions: {
        type_packs: [taskTypePack()]
      }
    };

    expect(validateAppManifest(manifest)).toEqual({ valid: true, issues: [] });
    expect(validateAppManifest({
      ...manifest,
      redirect_uris: ["com.attacker.app://auth/mdbase/callback"]
    }).valid).toBe(false);
  });

  it("defines first-class data contracts without erasing extension fields", () => {
    const contract = defineDataContract({
      kind: "mdbase.contract",
      contract_type: "record",
      id: "example.work-item",
      version: "1.0.0",
      record_schema: {
        dialect: "json-schema-2020-12",
        value: { type: "object" }
      },
      "x-example": { owner: "Tasks" }
    });
    expect(contract["x-example"].owner).toBe("Tasks");
    expect(() => defineDataContract({
      kind: "mdbase.contract",
      contract_type: "record",
      id: "Invalid Contract",
      version: "1",
      record_schema: {
        dialect: "json-schema-2020-12",
        value: { type: "object" }
      }
    })).toThrow(DataContractDefinitionError);
    expect(validateDataContract(contract).valid).toBe(true);
  });

  it("defines event and action contracts without pretending types implement them", () => {
    const event = defineDataContract({
      kind: "mdbase.contract",
      contract_type: "event",
      id: "example.work-item.completed",
      version: "1.0.0",
      data_schema: {
        dialect: "json-schema-2020-12",
        value: { type: "object", required: ["id"], properties: { id: { type: "string" } } }
      }
    });
    const action = defineDataContract({
      kind: "mdbase.contract",
      contract_type: "action",
      id: "example.work-item.create",
      version: "1.0.0",
      input_schema: {
        dialect: "json-schema-2020-12",
        value: { type: "object", required: ["title"], properties: { title: { type: "string" } } }
      }
    });

    expect(validateDataContract(event).valid).toBe(true);
    expect(validateDataContract(action).valid).toBe(true);
    expect(validateDataContract({
      ...event,
      record_schema: event.data_schema
    }).valid).toBe(false);
  });

  it("builds readable type packs with exact generated resource digests", () => {
    const document = "---\nkind: mdbase.type\nname: task\nversion: 1\n---\n";
    const pack = defineTypePack({
      id: "example.tasks",
      version: "1.0.0",
      resources: [{
        kind: "type",
        source: "_types/task.md",
        document
      }],
      provides: [{ id: "example.work-item", version: "1.0.0" }]
    });
    expect(pack.manifest.resources[0]).toEqual({
      kind: "type",
      source: "_types/task.md",
      target: "_types/task.md",
      digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
    });
    expect(() => defineTypePack({
      id: "invalid",
      version: "1",
      resources: [],
      provides: []
    })).toThrow(TypePackDefinitionError);
  });

  it("validates addressable wire definitions", () => {
    expect(validateProtocolValue({ valid: true, result: {}, diagnostics: [] }, "operationEnvelope").valid)
      .toBe(true);
    expect(validateProtocolValue({ valid: true, result: {} }, "operationEnvelope").valid)
      .toBe(false);
  });
});

describe("developer sandbox", () => {
  it("treats seeded and created body-only records as ordinary empty-frontmatter records", async () => {
    const { client, transport } = createSandbox({
      records: [{ path: "seed.md", body: "# Seed" }]
    });

    const seed = await client.read({ path: "seed.md" });
    expect(seed.result).toMatchObject({
      path: "seed.md",
      frontmatter: {},
      effective_frontmatter: {},
      body: "# Seed",
      types: []
    });

    const created = await client.create({ path: "created.md", body: "# Created" });
    expect(created.result.frontmatter).toEqual({});
    expect(transport.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "created.md",
        frontmatter: {},
        body: "# Created",
        types: []
      })
    ]));
  });

  it("runs a typed CRUD lifecycle with opaque revision preconditions", async () => {
    const { client, transport } = createSandbox<{ type: string; title: string; status?: string }>({
      description: taskDescription,
      records: [{
        path: "tasks/seed.md",
        types: ["task"],
        frontmatter: { type: "task", title: "Seed" }
      }]
    });

    const seed = await client.read({ path: "tasks/seed.md" });
    expect(seed.valid).toBe(true);
    expect(seed.result.effective_frontmatter.status).toBe("open");
    expect(seed.result.frontmatter).not.toHaveProperty("status");
    expect(seed.result).toEqual(expect.objectContaining({
      path: "tasks/seed.md",
      revision: expect.any(String),
      types: ["task"],
      body: "",
      file: expect.objectContaining({
        name: "seed.md",
        folder: "tasks",
        size: expect.any(Number),
        mtime: expect.any(String)
      })
    }));

    const created = await client.create({
      type: "task",
      path: "tasks/new.md",
      frontmatter: { type: "task", title: "New" }
    });
    expect(created.valid).toBe(true);
    const updated = await client.update({
      path: "tasks/new.md",
      patch: { title: "Updated" },
      if_revision: created.result.revision
    });
    expect(updated.valid).toBe(true);
    expect(updated.result.frontmatter.title).toBe("Updated");
    expect(updated.result.effective_frontmatter).toEqual({
      type: "task",
      title: "Updated",
      status: "open"
    });
    expect(updated.result.file.name).toBe("new.md");

    const stale = await client.update({
      path: "tasks/new.md",
      patch: { title: "Stale" },
      if_revision: created.result.revision
    });
    expect(stale.valid).toBe(false);
    expect(stale.diagnostics[0]?.code).toBe("concurrent_modification");
    expect(transport.snapshot().find((record) => record.path === "tasks/new.md")?.frontmatter.title)
      .toBe("Updated");
  });

  it("supports type filtering, pagination, and resumable change cursors", async () => {
    const { client } = createSandbox({
      description: taskDescription,
      records: [
        { path: "tasks/b.md", types: ["task"], frontmatter: { type: "task", title: "B" } },
        { path: "tasks/a.md", types: ["task"], frontmatter: { type: "task", title: "A" } },
        { path: "notes/a.md", types: ["note"], frontmatter: { type: "note", title: "Note" } }
      ]
    });
    expect(await client.changes()).toEqual({ events: [], cursor: 0, has_more: false, reset: false });
    const page = await client.query({ types: ["task"], offset: 1, limit: 1 });
    expect(page.result.results.map((record) => record.path)).toEqual(["tasks/b.md"]);
    expect(page.result.results[0]).toHaveProperty("effective_frontmatter");
    expect(page.result.results[0]?.file.path).toBe("tasks/b.md");
    expect(page.result.results[0]).not.toHaveProperty("frontmatter");
    expect(page.result.meta).toEqual({ total_count: 2, has_more: false });
    const both = await client.query({ types: ["task"], limit: 1, frontmatter_mode: "both" });
    expect(both.result.results[0]).toEqual(expect.objectContaining({
      frontmatter: expect.objectContaining({ title: "A" }),
      effective_frontmatter: expect.objectContaining({ title: "A" })
    }));

    await client.create({ path: "tasks/c.md", type: "task", frontmatter: { type: "task", title: "C" } });
    await client.create({ path: "tasks/d.md", type: "task", frontmatter: { type: "task", title: "D" } });
    const first = await client.changes({ after: 0, limit: 1 });
    expect(first.events).toHaveLength(1);
    expect(first.has_more).toBe(true);
    const second = await client.changes({ after: first.cursor, limit: 10 });
    expect(second.events.map((event) => event.payload.path)).toEqual(["tasks/d.md"]);
  });

  it("preflights rename and delete without mutating sandbox state", async () => {
    const { client, transport } = createSandbox({
      records: [
        { path: "target.md", frontmatter: { title: "Target" }, body: "Target body" },
        { path: "ref.md", frontmatter: { title: "Ref" }, body: "See [[target]]." }
      ]
    });
    const target = await client.read({ path: "target.md" });

    const rename = await client.preflightRename({
      from: "target.md",
      to: "Archive/target.md",
      update_refs: true,
      if_revision: target.result.revision
    });
    expect(rename.result).toMatchObject({
      dry_run: true,
      would_rename: true
    });
    const deletion = await client.preflightDelete({
      path: "target.md",
      if_revision: target.result.revision
    });
    expect(deletion.result).toMatchObject({
      deleted: false,
      dry_run: true,
      would_delete: true
    });
    expect(transport.snapshot().map((record) => record.path).sort()).toEqual(["ref.md", "target.md"]);
    expect(await client.changes()).toEqual({ events: [], cursor: 0, has_more: false, reset: false });
  });

  it("preserves deleted record types in the canonical event field", async () => {
    const { client } = createSandbox({
      records: [
        {
          path: "tasks/deleted.md",
          types: ["task"],
          frontmatter: { type: "task", title: "Deleted" }
        }
      ]
    });
    const deleted = await client.delete({ path: "tasks/deleted.md" });
    expect(deleted.valid).toBe(true);
    const changes = await client.changes({ after: 0 });
    expect(changes.events).toHaveLength(1);
    expect(changes.events[0]).toMatchObject({
      type: "mdbase.record.deleted",
      payload: { path: "tasks/deleted.md", types: ["task"] }
    });
    expect(changes.events[0]?.payload).not.toHaveProperty("previous_types");
  });

  it("rejects semantic approximations and unsafe paths explicitly", async () => {
    const { client } = createSandbox();
    await expect(client.query({ where: "status == 'open'" })).rejects.toMatchObject({
      code: "sandbox_unsupported"
    });
    await expect(client.create({ path: "../outside.md", frontmatter: {} })).rejects.toMatchObject({
      code: "invalid_path"
    });
  });

  it("does not expose mutable references to sandbox state", async () => {
    const { client, transport } = createSandbox({
      records: [{ path: "record.md", frontmatter: { nested: { value: 1 } } }]
    });
    const read = await client.read({ path: "record.md" });
    (read.result.frontmatter.nested as { value: number }).value = 2;
    const snapshot = transport.snapshot();
    expect((snapshot[0]?.frontmatter.nested as { value: number }).value).toBe(1);
  });
});
