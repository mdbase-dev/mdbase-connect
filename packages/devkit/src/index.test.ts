import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { CollectionDescription } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, type ConnectOutcome } from "@mdbase-dev/connect";
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

function requireOutcome<Value>(outcome: ConnectOutcome<Value>): Value {
  if (!outcome.ok) throw new MdbaseConnectError(outcome.problem);
  return outcome.value;
}

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

const workItemDigest = `sha256:${"a".repeat(64)}`;

function taskTypePack(provides = [{
  id: "example.work-item",
  version: "1.0.0",
  digest: workItemDigest
}]) {
  const document = "---\nkind: mdbase.type\nname: task\n---\n";
  return {
    manifest: {
      kind: "mdbase.type-pack",
      id: "example.tasks",
      version: "1.0.0",
      resources: [{
        kind: "type",
        mode: "seed",
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
  it("validates semantic capability contracts against application features", () => {
    const base = {
      manifest_version: 1 as const,
      id: "dev.example.capabilities",
      name: "Capabilities",
      homepage: "https://capabilities.example/",
      redirect_uris: ["https://capabilities.example/callback"],
      requirements: {
        contracts: [],
        capabilities: {
          contract_version: 1 as const,
          required: ["collection.inspect", "files.read"],
          optional: ["records.query"]
        },
        files: { scope: { kind: "selected_folders", folders: ["attachments"] }, actions: ["read"] }
      }
    };
    expect(validateAppManifest(base)).toEqual({ valid: true, issues: [] });
    expect(validateAppManifest({
      ...base,
      requirements: {
        ...base.requirements,
        capabilities: {
          ...base.requirements.capabilities,
          optional: ["collection.inspect"]
        }
      }
    }).valid).toBe(false);
    expect(validateAppManifest({
      ...base,
      requirements: {
        ...base.requirements,
        files: {
          scope: { kind: "selected_folders", folders: ["attachments"] },
          actions: ["read", "add"]
        }
      }
    }).valid).toBe(false);
    expect(validateAppManifest({
      ...base,
      provisions: { type_packs: [] }
    }).valid).toBe(true);
    expect(validateAppManifest({
      ...base,
      provisions: { type_packs: [taskTypePack([])] }
    }).valid).toBe(false);
    expect(validateAppManifest({
      ...base,
      requirements: {
        ...base.requirements,
        access: "full_collection",
        capabilities: {
          ...base.requirements.capabilities,
          required: [
            ...base.requirements.capabilities.required,
            "collection.setup.apply"
          ]
        }
      },
      provisions: { type_packs: [taskTypePack([])] }
    }).valid).toBe(true);
    expect(validateAppManifest({
      ...base,
      requirements: {
        ...base.requirements,
        access: "contract",
        contracts: [{ id: "example.work-item", version: "1.0.0", digest: workItemDigest }]
      }
    }).valid).toBe(false);
  });

  it("validates public application manifests with the packaged schema", () => {
    expect(validateAppManifest({
      manifest_version: 1,
      id: "example.tasks.desktop",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["https://tasks.example/callback"],
      requirements: {
        contracts: [{ id: "example.work-item", version: "1.0.0", digest: workItemDigest }]
      }
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
      requirements: {
        contracts: [{ id: "example.work-item", version: "1.0.0", digest: workItemDigest }]
      },
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
      requirements: {
        contracts: [{ id: "example.work-item", version: "1.0.0", digest: workItemDigest }]
      },
      provisions: {
        type_packs: [taskTypePack([{
          id: "other.contract",
          version: "1.0.0",
          digest: workItemDigest
        }])]
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
      requirements: {
        contracts: [{ id: "example.work-item", version: "1.0.0", digest: workItemDigest }]
      },
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
    const contract = "---\nkind: mdbase.contract\ncontract_type: record\nid: example.work-item\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n---\n";
    const type = "---\nkind: mdbase.type\nname: task\nversion: 1\n---\n";
    const pack = defineTypePack({
      id: "example.tasks",
      version: "1.0.0",
      resources: [
        {
          kind: "contract",
          mode: "managed",
          source: "_contracts/example.work-item.md",
          document: contract
        },
        {
          kind: "type",
          mode: "seed",
          source: "_types/task.md",
          document: type
        }
      ]
    });
    expect(pack.manifest.resources[1]).toEqual({
      kind: "type",
      mode: "seed",
      source: "_types/task.md",
      target: "_types/task.md",
      digest: `sha256:${createHash("sha256").update(type).digest("hex")}`
    });
    expect(pack.provides).toEqual([{
      id: "example.work-item",
      version: "1.0.0",
      digest: "sha256:e3746db7f1f74be3e2621ee6dd87d6b6c56294cdd2e13de117f959c0f305f8ab"
    }]);
    expect(() => defineTypePack({
      id: "invalid",
      version: "1",
      resources: []
    })).toThrow(TypePackDefinitionError);
    expect(() => defineTypePack({
      id: "example.seed-contract",
      version: "1.0.0",
      resources: [{
        kind: "contract",
        mode: "seed",
        source: "_contracts/example.work-item.md",
        document: contract
      }]
    })).toThrow("contract resources must be managed");
  });

  it("validates addressable wire definitions", () => {
    expect(validateProtocolValue({ valid: true, result: {}, diagnostics: [] }, "operationEnvelope").valid)
      .toBe(true);
    expect(validateProtocolValue({ valid: true, result: {} }, "operationEnvelope").valid)
      .toBe(false);
    const rejected = {
      protocol_version: 2,
      request_id: "00000000-0000-4000-8000-000000000001",
      ok: false,
      problem: {
        problem_version: 1,
        code: "access_paused",
        category: "availability",
        recovery: "resume_connector_access",
        message: "Remote access is paused.",
        operation_outcome: "rejected"
      }
    };
    expect(validateProtocolValue(rejected, "operationHttpResponse").valid).toBe(true);
    expect(validateProtocolValue({
      ...rejected,
      problem: { code: "access_paused", message: "Missing canonical metadata." }
    }, "operationHttpResponse").valid).toBe(false);
  });
});

describe("developer sandbox", () => {
  it("treats seeded and created body-only records as ordinary empty-frontmatter records", async () => {
    const { client, transport } = createSandbox({
      records: [{ path: "seed.md", body: "# Seed" }]
    });

    const seed = requireOutcome(await client.read({ path: "seed.md" }));
    expect(seed).toMatchObject({
      path: "seed.md",
      frontmatter: {},
      effectiveFrontmatter: {},
      body: "# Seed",
      types: []
    });

    const created = requireOutcome(await client.create({ path: "created.md", body: "# Created" }));
    expect(created.frontmatter).toEqual({});
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

    const seed = requireOutcome(await client.read({ path: "tasks/seed.md" }));
    expect(seed.effectiveFrontmatter.status).toBe("open");
    expect(seed.frontmatter).not.toHaveProperty("status");
    expect(seed).toEqual(expect.objectContaining({
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

    const created = requireOutcome(await client.create({
      type: "task",
      path: "tasks/new.md",
      frontmatter: { type: "task", title: "New" }
    }));
    const updated = requireOutcome(await client.update({
      path: "tasks/new.md",
      patch: { title: "Updated" },
      ifRevision: created.revision
    }));
    expect(updated.frontmatter.title).toBe("Updated");
    expect(updated.effectiveFrontmatter).toEqual({
      type: "task",
      title: "Updated",
      status: "open"
    });
    expect(updated.file.name).toBe("new.md");

    const stale = await client.update({
      path: "tasks/new.md",
      patch: { title: "Stale" },
      ifRevision: created.revision
    });
    expect(stale).toMatchObject({
      ok: false,
      problem: {
        code: "operation_invalid",
        operation_outcome: "rejected",
        details: { diagnostics: [{ code: "concurrent_modification" }] }
      }
    });
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
    expect(requireOutcome(await client.changes())).toEqual({ events: [], cursor: 0, hasMore: false, reset: false });
    const page = requireOutcome(await client.query({ types: ["task"], offset: 1, limit: 1 }));
    expect(page.results.map((record) => record.path)).toEqual(["tasks/b.md"]);
    expect(page.results[0]).toHaveProperty("effectiveFrontmatter");
    expect(page.results[0]?.file.path).toBe("tasks/b.md");
    expect(page.results[0]).not.toHaveProperty("frontmatter");
    expect(page.meta).toEqual({ totalCount: 2, hasMore: false });
    const both = requireOutcome(await client.query({ types: ["task"], limit: 1, frontmatterMode: "both" }));
    expect(both.results[0]).toEqual(expect.objectContaining({
      frontmatter: expect.objectContaining({ title: "A" }),
      effectiveFrontmatter: expect.objectContaining({ title: "A" })
    }));

    await client.create({ path: "tasks/c.md", type: "task", frontmatter: { type: "task", title: "C" } });
    await client.create({ path: "tasks/d.md", type: "task", frontmatter: { type: "task", title: "D" } });
    const first = requireOutcome(await client.changes({ after: 0, limit: 1 }));
    expect(first.events).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = requireOutcome(await client.changes({ after: first.cursor, limit: 10 }));
    expect(second.events.map((event) => event.payload.path)).toEqual(["tasks/d.md"]);
  });

  it("preflights rename and delete without mutating sandbox state", async () => {
    const { client, transport } = createSandbox({
      records: [
        { path: "target.md", frontmatter: { title: "Target" }, body: "Target body" },
        { path: "ref.md", frontmatter: { title: "Ref" }, body: "See [[target]]." }
      ]
    });
    const target = requireOutcome(await client.read({ path: "target.md" }));

    const rename = requireOutcome(await client.preflightRename({
      from: "target.md",
      to: "Archive/target.md",
      updateRefs: true,
      ifRevision: target.revision
    }));
    expect(rename).toMatchObject({
      dryRun: true,
      wouldRename: true
    });
    const deletion = requireOutcome(await client.preflightDelete({
      path: "target.md",
      ifRevision: target.revision
    }));
    expect(deletion).toMatchObject({
      deleted: false,
      dryRun: true,
      wouldDelete: true
    });
    expect(transport.snapshot().map((record) => record.path).sort()).toEqual(["ref.md", "target.md"]);
    expect(requireOutcome(await client.changes())).toEqual({ events: [], cursor: 0, hasMore: false, reset: false });
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
    requireOutcome(await client.delete({ path: "tasks/deleted.md" }));
    const changes = requireOutcome(await client.changes({ after: 0 }));
    expect(changes.events).toHaveLength(1);
    expect(changes.events[0]).toMatchObject({
      type: "mdbase.record.deleted",
      payload: { path: "tasks/deleted.md", types: ["task"] }
    });
    expect(changes.events[0]?.payload).not.toHaveProperty("previous_types");
  });

  it("rejects semantic approximations and unsafe paths explicitly", async () => {
    const { client } = createSandbox();
    await expect(client.query({ where: "status == 'open'" })).resolves.toMatchObject({
      ok: false,
      problem: { code: "sandbox_unsupported" }
    });
    await expect(client.create({ path: "../outside.md", frontmatter: {} })).resolves.toMatchObject({
      ok: false,
      problem: { code: "invalid_path" }
    });
  });

  it("does not expose mutable references to sandbox state", async () => {
    const { client, transport } = createSandbox({
      records: [{ path: "record.md", frontmatter: { nested: { value: 1 } } }]
    });
    const read = requireOutcome(await client.read({ path: "record.md" }));
    (read.frontmatter.nested as { value: number }).value = 2;
    const snapshot = transport.snapshot();
    expect((snapshot[0]?.frontmatter.nested as { value: number }).value).toBe(1);
  });
});
