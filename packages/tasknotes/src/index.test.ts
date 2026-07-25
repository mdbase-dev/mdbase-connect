import { describe, expect, it, vi } from "vitest";
import {
  resolveTasknotesContract,
  resolveTasknotesSyncContract,
  TasknotesCollection,
  TasknotesOfflineCollection,
  TasknotesContractError,
  type TaskFrontmatter
} from "./index.js";
import { MemoryHostedAuthority, MemoryReplicaStore, OfflineReplica } from "@mdbase/connect-sync";

const description = {
  protocol_version: 1 as const,
  collection_id: "collection",
  display_name: "Tasks",
  spec_version: "0.3.0",
  operations: ["describe", "read", "query", "create", "update"] as any,
  change_cursor: 0,
  types: [{
    name: "task",
    schema: {
      type: "object",
      required: ["name", "state"],
      properties: {
        name: { type: "string", title: "Task name" },
        state: { enum: ["open", "closed"] },
        urgency: { enum: ["low", "high"] },
        estimate: { type: "number", title: "Effort" },
        reviewed: { type: "boolean" }
      }
    },
    collection: {
      display: { name_field: "name" },
      path: { folder: "inbox", template: "{{title}}-{{id}}" }
    },
    extensions: {}
  }],
  contracts: [{
    id: "tasknotes.task",
    version: 1,
    type_name: "task",
    extension: "x-tasknotes",
    configuration: {
      contract: "tasknotes.task",
      version: 1,
      field_roles: {
        title: "name",
        status: "state",
        priority: "urgency",
        timeEstimate: "estimate"
      },
      status: {
        values: ["open", "closed"],
        completed_values: ["closed"],
        default: "open",
        definitions: [
          { value: "open", label: "Ready", order: 1 },
          { value: "closed", label: "Finished", is_completed: true, order: 2 }
        ]
      },
      priority: {
        values: ["low", "high"],
        default: "low",
        definitions: [
          { value: "low", label: "Low", weight: 1 },
          { value: "high", label: "High", weight: 10 }
        ]
      }
    }
  }]
};

describe("TaskNotes contract adapter", () => {
  it("uses declared field roles for create and completion", async () => {
    const contract = resolveTasknotesContract(description);
    expect(contract.pathFolder).toBe("inbox");
    expect(contract.pathTemplate).toBe("{{title}}-{{id}}");
    expect(contract.fieldMapping.priority).toBe("urgency");
    expect(contract.statuses.map((status) => status.label)).toEqual(["Ready", "Finished"]);
    expect(contract.priorities.map((priority) => priority.value)).toEqual(["low", "high"]);
    expect(contract.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "estimate", role: "timeEstimate", kind: "number" }),
      expect.objectContaining({ key: "reviewed", kind: "boolean" })
    ]));
    const connect = {
      describe: vi.fn().mockResolvedValue(description),
      query: vi.fn().mockResolvedValue({ valid: true, diagnostics: [], result: { results: [] } }),
      create: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { path: "inbox/write-docs.md", frontmatter: {}, types: ["task"], revision: "one" }
      }),
      read: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { path: "inbox/write-docs.md", frontmatter: { name: "Write docs", state: "open" }, types: ["task"], revision: "one" }
      }),
      update: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { path: "inbox/write-docs.md", frontmatter: { state: "closed" }, types: ["task"], revision: "two" }
      })
    } as any;
    const tasks = new TasknotesCollection(connect);

    await tasks.create({ title: "Write docs" });
    expect(connect.create).toHaveBeenCalledWith(expect.objectContaining({
      path: undefined,
      frontmatter: { name: "Write docs", state: "open" }
    }));

    await tasks.setCompleted("inbox/write-docs.md", true);
    expect(connect.update).toHaveBeenCalledWith({
      path: "inbox/write-docs.md",
      patch: { state: "closed" },
      if_revision: "one"
    });
  });

  it("refreshes its cached contract after a type change", async () => {
    const renamed = {
      ...description,
      types: [{
        ...description.types[0],
        schema: {
          ...description.types[0].schema,
          properties: {
            ...description.types[0].schema.properties,
            summary: { type: "string" },
            phase: { enum: ["queued", "finished"] }
          }
        }
      }],
      contracts: [{
        ...description.contracts[0],
        configuration: {
          ...description.contracts[0].configuration,
          field_roles: {
            ...description.contracts[0].configuration.field_roles,
            title: "summary",
            status: "phase"
          },
          status: {
            values: ["queued", "finished"],
            completed_values: ["finished"],
            default: "queued"
          }
        }
      }]
    };
    const connect = {
      describe: vi.fn()
        .mockResolvedValueOnce(description)
        .mockResolvedValueOnce(renamed),
      query: vi.fn()
        .mockResolvedValueOnce({
          valid: true,
          diagnostics: [],
          result: {
            results: [{
              path: "inbox/one.md",
              frontmatter: { name: "Before", state: "open" },
              types: ["task"]
            }]
          }
        })
        .mockResolvedValueOnce({
          valid: true,
          diagnostics: [],
          result: {
            results: [{
              path: "inbox/one.md",
              frontmatter: { summary: "After", phase: "finished" },
              types: ["task"]
            }]
          }
        })
    } as any;
    const tasks = new TasknotesCollection(connect);

    expect((await tasks.list())[0]).toEqual(expect.objectContaining({
      title: "Before",
      completed: false
    }));
    await tasks.refreshContract();
    expect((await tasks.list())[0]).toEqual(expect.objectContaining({
      title: "After",
      completed: true
    }));
    expect(connect.describe).toHaveBeenCalledTimes(2);
  });

  it("rejects empty titles and unsafe contract field paths", async () => {
    const offline = new TasknotesOfflineCollection({} as never, resolveTasknotesContract(description));
    await expect(offline.create({ title: "   " })).rejects.toBeInstanceOf(TasknotesContractError);
    expect(() => resolveTasknotesContract({
      ...description,
      contracts: [{
        ...description.contracts[0],
        configuration: {
          ...description.contracts[0].configuration,
          field_roles: { title: "__proto__.polluted", status: "state" }
        }
      }]
    })).toThrow(TasknotesContractError);
  });
});

describe("TaskNotes offline hosted adapter", () => {
  it("creates and updates tasks optimistically, then converges through sync", async () => {
    const authority = new MemoryHostedAuthority<TaskFrontmatter>({
      resources: {
        revision: "fixture:1",
        spec_version: description.spec_version,
        types: description.types,
        contracts: description.contracts
      }
    });
    const replicaId = authority.registerReplica({ name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replica = new OfflineReplica(
      authority.transport(replicaId),
      new MemoryReplicaStore<TaskFrontmatter>({ replicaId, records: {}, pending: [], conflicts: {} })
    );
    await replica.initialize();
    const resources = await replica.collectionResources();
    expect(resources).not.toBeNull();
    const offline = new TasknotesOfflineCollection(
      replica,
      resolveTasknotesSyncContract(resources!)
    );
    const recordId = await offline.create({ title: "Offline task" });
    expect(await offline.list()).toEqual([
      expect.objectContaining({ title: "Offline task", completed: false })
    ]);
    await offline.sync();
    await offline.setCompleted(recordId, true);
    expect((await offline.list())[0].completed).toBe(true);
    await offline.sync();
    expect(await replica.pending()).toEqual([]);
  });

  it("does not allow caller fields to change the task contract type", async () => {
    const authority = new MemoryHostedAuthority<TaskFrontmatter>();
    const replicaId = authority.registerReplica({ name: "Android", mode: "read_write", allowedTypes: ["task"] });
    const replica = new OfflineReplica(
      authority.transport(replicaId),
      new MemoryReplicaStore<TaskFrontmatter>({ replicaId, records: {}, pending: [], conflicts: {} })
    );
    await replica.initialize();
    const offline = new TasknotesOfflineCollection(replica, resolveTasknotesContract(description));
    await offline.create({ title: "Typed", fields: { type: "private" } });
    expect((await replica.records())[0].frontmatter.type).toBe("task");
  });
});
