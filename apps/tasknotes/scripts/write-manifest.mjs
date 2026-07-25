import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = (process.env.TASKNOTES_APP_ORIGIN ?? "http://localhost:5179").replace(/\/$/, "");
const target = resolve(import.meta.dirname, "..", "public", ".well-known", "mdbase-app.json");
const taskTypeDocument = `---
kind: mdbase.type
name: task
version: 1
description: A TaskNotes-compatible task.
collection:
  path:
    folder: tasks
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: task }
      title: { type: string, minLength: 1 }
      status: { enum: [open, done] }
x-tasknotes:
  contract: tasknotes.task
  version: 1
  field_roles: { title: title, status: status }
  status: { completed_values: [done], default: open }
---
`;
await mkdir(resolve(target, ".."), { recursive: true });
await writeFile(target, JSON.stringify({
  manifest_version: 1,
  id: "dev.mdbase.tasknotes-demo",
  name: "TaskNotes",
  homepage: origin,
  redirect_uris: [`${origin}/`],
  requirements: {
    contracts: [{ id: "tasknotes.task", version: 1 }]
  },
  provisions: {
    types: [{
      name: "task",
      path: "_types/task.md",
      document: taskTypeDocument,
      provides: [{ id: "tasknotes.task", version: 1 }]
    }]
  }
}, null, 2));
