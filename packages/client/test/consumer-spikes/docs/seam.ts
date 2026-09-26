// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import type { JsonObject } from "../../../api-candidate/index.js";
import type { MdbaseCollectionClient } from "../../../api-candidate/advanced.js";

interface Task extends JsonObject { title: string; status: string; due?: string }

export async function listOpenTasks(client: MdbaseCollectionClient<Task>) {
  return client.queryAll({
    types: ["task"],
    where: 'status == "open"',
    orderBy: [{ field: "due", direction: "asc" }]
  });
}
