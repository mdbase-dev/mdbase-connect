import { performance } from "node:perf_hooks";
import {
  resolveTasknotesContract,
  TasknotesCollection
} from "../dist/index.js";

const contractIterations = positiveInteger(
  process.env.TASKNOTES_PROFILE_CONTRACT_ITERATIONS,
  50_000
);
const taskCount = positiveInteger(process.env.TASKNOTES_PROFILE_TASKS, 10_000);
const listIterations = positiveInteger(
  process.env.TASKNOTES_PROFILE_LIST_ITERATIONS,
  20
);

const roles = {
  title: "summary",
  status: "state",
  priority: "urgency",
  due: "due_on",
  scheduled: "start_on",
  completedDate: "finished_on",
  dateModified: "updated_at",
  contexts: "areas",
  projects: "goals",
  timeEstimate: "estimate",
  recurrence: "repeat",
  completeInstances: "completed_runs",
  skippedInstances: "skipped_runs",
  timeEntries: "sessions"
};

const properties = {
  summary: { type: "string" },
  state: { enum: ["open", "doing", "done"] },
  urgency: { enum: ["low", "normal", "high"] },
  due_on: { type: "string", format: "date" },
  start_on: { type: "string", format: "date" },
  finished_on: { type: "string", format: "date" },
  updated_at: { type: "string", format: "date-time" },
  areas: { type: "array", items: { type: "string" } },
  goals: { type: "array", items: { type: "string" } },
  estimate: { type: "integer" },
  repeat: { type: "string" },
  completed_runs: { type: "array", items: { type: "string" } },
  skipped_runs: { type: "array", items: { type: "string" } },
  sessions: { type: "array", items: { type: "object" } },
  reviewed: { type: "boolean" },
  client: { type: "string" }
};

const description = {
  protocol_version: 1,
  collection_id: "profile",
  display_name: "TaskNotes profile",
  spec_version: "0.3.0",
  operations: ["describe", "query"],
  change_cursor: 0,
  types: [{
    name: "custom-task",
    schema: { type: "object", properties },
    collection: {
      path: { folder: "Tasks", template: "{{title}}-{{id}}" }
    },
    extensions: {}
  }],
  contracts: [{
    id: "tasknotes.task",
    version: 1,
    type_name: "custom-task",
    extension: "x-tasknotes",
    configuration: {
      contract: "tasknotes.task",
      version: 1,
      field_roles: roles,
      status: {
        values: ["open", "doing", "done"],
        completed_values: ["done"],
        default: "open",
        definitions: [
          { value: "open", label: "Ready", order: 1 },
          { value: "doing", label: "In progress", order: 2 },
          { value: "done", label: "Done", is_completed: true, order: 3 }
        ]
      },
      priority: {
        values: ["low", "normal", "high"],
        default: "normal"
      }
    }
  }]
};

const records = Array.from({ length: taskCount }, (_, index) => ({
  path: `Tasks/${index}.md`,
  frontmatter: {
    summary: `Task ${index}`,
    state: index % 2 ? "open" : "done",
    urgency: "normal",
    due_on: "2026-08-01",
    estimate: index % 120,
    reviewed: index % 3 === 0,
    client: "Example"
  },
  types: ["custom-task"]
}));

let started = performance.now();
for (let index = 0; index < contractIterations; index += 1) {
  resolveTasknotesContract(description);
}
const contractMilliseconds = performance.now() - started;

const connection = {
  describe: async () => description,
  query: async () => ({
    valid: true,
    diagnostics: [],
    result: { results: records }
  })
};
const collection = new TasknotesCollection(connection);
started = performance.now();
for (let index = 0; index < listIterations; index += 1) await collection.list();
const listMilliseconds = performance.now() - started;

console.log(JSON.stringify({
  contract: {
    iterations: contractIterations,
    total_ms: round(contractMilliseconds),
    mean_us: round(contractMilliseconds * 1_000 / contractIterations)
  },
  normalization: {
    tasks: taskCount * listIterations,
    total_ms: round(listMilliseconds),
    mean_us_per_task: round(listMilliseconds * 1_000 / (taskCount * listIterations))
  },
  memory: {
    heap_used_mb: round(process.memoryUsage().heapUsed / 1024 / 1024)
  }
}, null, 2));

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value) {
  return Number(value.toFixed(3));
}
