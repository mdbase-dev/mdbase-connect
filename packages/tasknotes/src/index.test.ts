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
        deadline: { type: "string", format: "date" },
        start_on: { type: "string", format: "date" },
        areas: { type: "array", items: { type: "string" } },
        goals: { type: "array", items: { type: "string" } },
        repeat: { type: "string" },
        completed_runs: { type: "array", items: { type: "string", format: "date" } },
        skipped_runs: { type: "array", items: { type: "string", format: "date" } },
        finished_on: { type: "string", format: "date" },
        updated_at: { type: "string", format: "date-time" },
        sessions: { type: "array", items: { type: "object" } },
        reviewed: { type: "boolean", default: false }
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
        timeEstimate: "estimate",
        due: "deadline",
        scheduled: "start_on",
        contexts: "areas",
        projects: "goals",
        recurrence: "repeat",
        completeInstances: "completed_runs",
        skippedInstances: "skipped_runs",
        completedDate: "finished_on",
        dateModified: "updated_at",
        timeEntries: "sessions"
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
      frontmatter: expect.objectContaining({
        name: "Write docs",
        state: "open",
        urgency: "low"
      })
    }));

    await tasks.setCompleted("inbox/write-docs.md", true);
    expect(connect.update).toHaveBeenCalledWith(expect.objectContaining({
      path: "inbox/write-docs.md",
      patch: expect.objectContaining({
        state: "closed",
        finished_on: expect.any(String),
        updated_at: expect.any(String)
      }),
      if_revision: "one"
    }));
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

  it("normalizes mapped core roles and schema-defined custom fields", async () => {
    const connect = {
      describe: vi.fn().mockResolvedValue(description),
      query: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: {
          results: [{
            path: "inbox/mapped.md",
            frontmatter: {
              name: "Mapped task",
              state: "open",
              urgency: "high",
              deadline: "2026-08-01",
              start_on: "2026-07-30",
              estimate: 45,
              areas: ["home"],
              goals: ["[[Launch]]"],
              reviewed: true
            },
            types: ["task"]
          }]
        }
      })
    } as any;

    const task = (await new TasknotesCollection(connect).list())[0];
    expect(task).toEqual(expect.objectContaining({
      title: "Mapped task",
      status: "open",
      priority: "high",
      due: "2026-08-01",
      scheduled: "2026-07-30",
      timeEstimate: 45,
      contexts: ["home"],
      projects: ["[[Launch]]"],
      customProperties: { reviewed: true }
    }));
  });

  it("uses model-planned completion, stops active tracking, and archives immediately", async () => {
    const semanticDescription = {
      ...description,
      contracts: [{
        ...description.contracts[0],
        configuration: {
          ...description.contracts[0].configuration,
          status: {
            ...description.contracts[0].configuration.status,
            definitions: [
              { value: "open", label: "Ready", order: 1 },
              {
                value: "closed",
                label: "Finished",
                is_completed: true,
                auto_archive: true,
                auto_archive_delay_minutes: 0,
                order: 2
              }
            ]
          },
          time_tracking: { auto_stop_on_complete: true },
          archive: {
            tags_field: "tags",
            archived_tag: "archived",
            move_on_archive: true,
            folder: "Archive"
          }
        }
      }]
    };
    const connect = {
      describe: vi.fn().mockResolvedValue(semanticDescription),
      read: vi.fn()
        .mockResolvedValueOnce({
          valid: true,
          diagnostics: [],
          result: {
            path: "inbox/tracked.md",
            frontmatter: {
              name: "Tracked",
              state: "open",
              tags: ["work"],
              sessions: [{ startTime: "2026-07-25T12:00:00.000Z" }]
            },
            types: ["task"],
            revision: "one"
          }
        }),
      update: vi.fn().mockImplementation(async ({ patch }) => ({
        valid: true,
        diagnostics: [],
        result: {
          path: "inbox/tracked.md",
          frontmatter: patch,
          types: ["task"],
          revision: "two"
        }
      })),
      rename: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { from: "inbox/tracked.md", to: "Archive/tracked.md", revision: "three" }
      })
    } as any;

    await new TasknotesCollection(connect).setCompleted("inbox/tracked.md", true);

    expect(connect.update).toHaveBeenCalledWith(expect.objectContaining({
      path: "inbox/tracked.md",
      patch: expect.objectContaining({
        state: "closed",
        finished_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        updated_at: expect.any(String),
        tags: ["work", "archived"],
        sessions: [expect.objectContaining({
          startTime: "2026-07-25T12:00:00.000Z",
          endTime: expect.any(String)
        })]
      })
    }));
    expect(connect.rename).toHaveBeenCalledWith({
      from: "inbox/tracked.md",
      to: "Archive/tracked.md",
      if_revision: "two",
      update_refs: false
    });
  });

  it("advances recurring tasks through the shared TaskNotes operation planner", async () => {
    const connect = {
      describe: vi.fn().mockResolvedValue(description),
      read: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: {
          path: "inbox/daily.md",
          frontmatter: {
            name: "Daily",
            state: "open",
            start_on: "2026-07-26",
            deadline: "2026-07-27",
            repeat: "DTSTART:20260726;FREQ=DAILY",
            completed_runs: [],
            skipped_runs: []
          },
          types: ["task"],
          revision: "one"
        }
      }),
      update: vi.fn().mockImplementation(async ({ patch }) => ({
        valid: true,
        diagnostics: [],
        result: {
          path: "inbox/daily.md",
          frontmatter: patch,
          types: ["task"],
          revision: "two"
        }
      }))
    } as any;

    await new TasknotesCollection(connect).setCompleted("inbox/daily.md", true);
    const patch = connect.update.mock.calls[0][0].patch;
    expect(patch).toEqual(expect.objectContaining({
      repeat: expect.any(String),
      completed_runs: expect.arrayContaining([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)]),
      start_on: expect.any(String),
      deadline: expect.any(String),
      updated_at: expect.any(String)
    }));
    expect(patch).not.toHaveProperty("state");
    expect(patch).not.toHaveProperty("finished_on");
  });

  it("preserves siblings when updating a nested mapped field", async () => {
    const nested = {
      ...description,
      contracts: [{
        ...description.contracts[0],
        configuration: {
          ...description.contracts[0].configuration,
          field_roles: {
            ...description.contracts[0].configuration.field_roles,
            status: "workflow.state",
            completedDate: "workflow.completed"
          }
        }
      }]
    };
    const connect = {
      describe: vi.fn().mockResolvedValue(nested),
      read: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: {
          path: "inbox/nested.md",
          frontmatter: {
            name: "Nested",
            workflow: { state: "open", owner: "Callum" }
          },
          types: ["task"],
          revision: "one"
        }
      }),
      update: vi.fn().mockImplementation(async ({ patch }) => ({
        valid: true,
        diagnostics: [],
        result: {
          path: "inbox/nested.md",
          frontmatter: patch,
          types: ["task"],
          revision: "two"
        }
      }))
    } as any;

    await new TasknotesCollection(connect).setCompleted("inbox/nested.md", true);
    expect(connect.update).toHaveBeenCalledWith(expect.objectContaining({
      patch: {
        workflow: expect.objectContaining({
          state: "closed",
          owner: "Callum",
          completed: expect.any(String)
        }),
        updated_at: expect.any(String)
      }
    }));
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
