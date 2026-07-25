import type {
  JsonObject,
  RecordResult
} from "@mdbase/connect-protocol";
import type { MdbaseConnection, QueryResult } from "@mdbase/connect";
import type { OfflineReplica } from "@mdbase/connect-sync";
import {
  denormalizeSpecFrontmatter,
  normalizeSpecFrontmatter
} from "@tasknotes/model/config";
import { getCurrentDateString } from "@tasknotes/model/date";
import { mapTaskFromFrontmatter } from "@tasknotes/model/mapping";
import {
  buildSpecCompleteTaskUpdate,
  buildSpecStopTimeTrackingUpdate
} from "@tasknotes/model/operations";
import type { TaskInfo, UserMappedField } from "@tasknotes/model/types";
import {
  resolveTasknotesContract,
  TasknotesContractError,
  type TasknotesContract
} from "./contract.js";

export {
  resolveTasknotesContract,
  resolveTasknotesSyncContract,
  TASKNOTES_TASK_CONTRACT,
  TasknotesContractError
} from "./contract.js";
export type {
  TaskFieldDefinition,
  TaskFieldKind,
  TasknotesContract,
  TasknotesContractConfiguration
} from "./contract.js";

export interface TaskFrontmatter extends JsonObject {
  title?: string;
  status?: string;
}

export type TaskSummary = Partial<TaskInfo> & {
  path: string;
  title: string;
  status?: string;
  completed: boolean;
  frontmatter: TaskFrontmatter;
};

export interface CreateTaskInput {
  title: string;
  path?: string;
  fields?: JsonObject;
  body?: string;
}

export class TasknotesCollection {
  private contract: TasknotesContract | null = null;

  constructor(private readonly connect: MdbaseConnection<TaskFrontmatter>) {}

  async describe(): Promise<TasknotesContract> {
    this.contract ??= resolveTasknotesContract(await this.connect.describe());
    return this.contract;
  }

  invalidateContract(): void {
    this.contract = null;
  }

  async refreshContract(): Promise<TasknotesContract> {
    this.invalidateContract();
    return this.describe();
  }

  async list(): Promise<TaskSummary[]> {
    const contract = await this.describe();
    const response = await this.connect.query({ types: [contract.typeName] });
    assertValid(response);
    const query = response.result as QueryResult<TaskFrontmatter>;
    return query.results.map((record) => normalizeTask(record.path, record.frontmatter, contract));
  }

  async create(input: CreateTaskInput): Promise<RecordResult<TaskFrontmatter>> {
    const contract = await this.describe();
    const fields = createFields(contract, input.fields);
    setField(fields, roleField(contract, "title", "title"), taskTitle(input.title));
    const defaultStatus = contract.configuration.status.default;
    if (defaultStatus && getField(fields, roleField(contract, "status", "status")) === undefined) {
      setField(fields, roleField(contract, "status", "status"), defaultStatus);
    }
    const defaultPriority = contract.configuration.priority?.default;
    if (
      defaultPriority
      && getField(fields, roleField(contract, "priority", "priority")) === undefined
    ) {
      setField(fields, roleField(contract, "priority", "priority"), defaultPriority);
    }
    const response = await this.connect.create({
      type: contract.typeName,
      path: input.path ?? defaultTaskPath(input.title, contract),
      frontmatter: fields,
      body: input.body
    });
    assertValid(response);
    return response.result;
  }

  async setCompleted(path: string, completed: boolean): Promise<RecordResult<TaskFrontmatter>> {
    const contract = await this.describe();
    const read = await this.connect.read({ path });
    assertValid(read);
    const fields = completionPatch(
      read.result.raw_frontmatter ?? read.result.frontmatter,
      contract,
      completed,
      path
    );
    const updated = await this.connect.update({
      path,
      patch: fields,
      if_revision: read.result.revision
    });
    assertValid(updated);
    await this.moveArchivedTask(path, updated.result.revision, contract, completed);
    return updated.result;
  }

  async setStatus(path: string, status: string): Promise<RecordResult<TaskFrontmatter>> {
    const contract = await this.describe();
    const definition = contract.statuses.find((candidate) => candidate.value === status);
    if (!definition) {
      throw new TasknotesContractError(`Unknown TaskNotes status "${status}".`);
    }
    if (definition.isCompleted) return this.setCompleted(path, true);
    const read = await this.connect.read({ path });
    assertValid(read);
    const raw = read.result.raw_frontmatter ?? read.result.frontmatter;
    const patch: JsonObject = {};
    setPatchField(patch, raw, roleField(contract, "status", "status"), status);
    setPatchField(
      patch,
      raw,
      roleField(contract, "completedDate", "completedDate"),
      null
    );
    const updated = await this.connect.update({
      path,
      patch,
      if_revision: read.result.revision
    });
    assertValid(updated);
    return updated.result;
  }

  async setPriority(path: string, priority: string): Promise<RecordResult<TaskFrontmatter>> {
    const contract = await this.describe();
    if (!contract.priorities.some((candidate) => candidate.value === priority)) {
      throw new TasknotesContractError(`Unknown TaskNotes priority "${priority}".`);
    }
    return this.updateFields(path, {
      [roleField(contract, "priority", "priority")]: priority
    });
  }

  async updateFields(
    path: string,
    fields: JsonObject
  ): Promise<RecordResult<TaskFrontmatter>> {
    const read = await this.connect.read({ path });
    assertValid(read);
    const raw = read.result.raw_frontmatter ?? read.result.frontmatter;
    const patch: JsonObject = {};
    for (const [field, value] of Object.entries(fields)) {
      setPatchField(patch, raw, field, value);
    }
    const updated = await this.connect.update({
      path,
      patch,
      if_revision: read.result.revision
    });
    assertValid(updated);
    return updated.result;
  }

  private async moveArchivedTask(
    path: string,
    revision: string,
    contract: TasknotesContract,
    completed: boolean
  ): Promise<void> {
    if (!completed || contract.configuration.archive?.move_on_archive !== true) return;
    const status = completedStatus(contract);
    if (!status?.autoArchive || status.autoArchiveDelay > 0) return;
    const folder = stringValue(contract.configuration.archive.folder)?.replace(
      /^\/+|\/+$/g,
      ""
    );
    if (!folder || folder.includes("{{")) return;
    const filename = path.split("/").at(-1);
    if (!filename || path === `${folder}/${filename}`) return;
    const renamed = await this.connect.rename({
      from: path,
      to: `${folder}/${filename}`,
      if_revision: revision,
      update_refs: false
    });
    assertValid(renamed);
  }
}

/** TaskNotes domain operations over a persistent hosted-sync replica. */
export class TasknotesOfflineCollection {
  constructor(
    private readonly replica: OfflineReplica<TaskFrontmatter>,
    private readonly contract: TasknotesContract
  ) {}

  async list(): Promise<TaskSummary[]> {
    return (await this.replica.records())
      .filter((record) => record.types.includes(this.contract.typeName))
      .map((record) => normalizeTask(record.path, record.frontmatter, this.contract));
  }

  async create(input: CreateTaskInput): Promise<string> {
    const fields = createFields(this.contract, input.fields);
    setField(fields, roleField(this.contract, "title", "title"), taskTitle(input.title));
    const defaultStatus = this.contract.configuration.status.default;
    if (defaultStatus && getField(fields, roleField(this.contract, "status", "status")) === undefined) {
      setField(fields, roleField(this.contract, "status", "status"), defaultStatus);
    }
    const defaultPriority = this.contract.configuration.priority?.default;
    if (
      defaultPriority
      && getField(fields, roleField(this.contract, "priority", "priority")) === undefined
    ) {
      setField(fields, roleField(this.contract, "priority", "priority"), defaultPriority);
    }
    const record = await this.replica.queueCreate({
      path: input.path ?? defaultTaskPath(input.title, this.contract) ?? `tasks/${crypto.randomUUID()}.md`,
      frontmatter: { ...fields, type: this.contract.typeName },
      body: input.body,
      types: [this.contract.typeName]
    });
    return record.record_id;
  }

  async setCompleted(recordId: string, completed: boolean): Promise<void> {
    const record = (await this.replica.records()).find((candidate) => candidate.record_id === recordId);
    if (!record) throw new TasknotesContractError("Task is not available in the offline cache.");
    const patch = completionPatch(record.frontmatter, this.contract, completed, record.path);
    await this.replica.queueUpdate({ recordId, patch });
  }

  sync(): Promise<void> {
    return this.replica.sync();
  }
}

function normalizeTask(path: string, frontmatter: TaskFrontmatter, contract: TasknotesContract): TaskSummary {
  const modelFrontmatter: Record<string, unknown> = { ...frontmatter };
  for (const field of Object.values(contract.fieldMapping)) {
    const value = getField(frontmatter, field);
    if (value !== undefined) modelFrontmatter[field] = value;
  }
  const task = mapTaskFromFrontmatter(
    contract.fieldMapping,
    modelFrontmatter,
    path,
    contract.titleStorage === "filename",
    userFields(contract),
    contract.statuses,
    contract.priorities
  );
  const title = getField(frontmatter, roleField(contract, "title", "title"));
  const status = task.status
    ?? getField(frontmatter, roleField(contract, "status", "status"));
  return {
    ...task,
    path,
    title:
      task.title
      ?? (typeof title === "string" && title.length > 0 ? title : path),
    status: typeof status === "string" ? status : undefined,
    completed:
      typeof status === "string"
      && contract.configuration.status.completed_values.includes(status),
    frontmatter
  };
}

function roleField(contract: TasknotesContract, role: string, fallback: string): string {
  return contract.configuration.field_roles[role] ?? fallback;
}

function taskTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new TasknotesContractError("A task title is required.");
  return title;
}

function createFields(
  contract: TasknotesContract,
  provided: JsonObject | undefined
): JsonObject {
  const fields: JsonObject = {};
  for (const field of contract.fields) {
    if (field.defaultValue !== undefined && !field.readOnly) {
      setField(fields, field.key, cloneJson(field.defaultValue));
    }
  }
  for (const [key, value] of Object.entries(provided ?? {})) fields[key] = cloneJson(value);
  return fields;
}

function completionPatch(
  raw: TaskFrontmatter,
  contract: TasknotesContract,
  completed: boolean,
  path: string
): JsonObject {
  const status = completed ? completedStatus(contract)?.value : incompleteStatus(contract);
  if (!status) {
    throw new TasknotesContractError(
      "The TaskNotes contract does not define a status for this change."
    );
  }

  if (!completed) {
    const patch: JsonObject = {};
    setPatchField(patch, raw, roleField(contract, "status", "status"), status);
    setPatchField(
      patch,
      raw,
      roleField(contract, "completedDate", "completedDate"),
      null
    );
    return patch;
  }

  const currentTimestamp = new Date().toISOString();
  const normalized = normalizeSpecFrontmatter(
    mappedFrontmatter(raw, contract),
    contract.specFieldMapping
  );
  const plan = buildSpecCompleteTaskUpdate({
    frontmatter: normalized,
    targetDate: getCurrentDateString(),
    completedStatus: status,
    currentTimestamp,
    path
  });
  const roleFields: Record<string, unknown> = { ...plan.fields };

  if (contract.configuration.time_tracking?.auto_stop_on_complete === true) {
    const stopped = buildSpecStopTimeTrackingUpdate({
      frontmatter: { ...normalized, ...roleFields },
      currentTimestamp,
      path
    });
    if (stopped.changed) Object.assign(roleFields, stopped.fields);
  }

  const patch = roleFieldsPatch(raw, contract, roleFields);
  const definition = completedStatus(contract);
  if (definition?.autoArchive && definition.autoArchiveDelay <= 0) {
    applyArchiveTag(patch, raw, contract);
  }
  return patch;
}

function mappedFrontmatter(
  raw: TaskFrontmatter,
  contract: TasknotesContract
): Record<string, unknown> {
  const mapped: Record<string, unknown> = { ...raw };
  for (const field of Object.values(contract.specFieldMapping.roleToField)) {
    const value = getField(raw, field);
    if (value !== undefined) mapped[field] = value;
  }
  return mapped;
}

function roleFieldsPatch(
  raw: TaskFrontmatter,
  contract: TasknotesContract,
  fields: Record<string, unknown>
): JsonObject {
  const denormalized = denormalizeSpecFrontmatter(fields, contract.specFieldMapping);
  const patch: JsonObject = {};
  for (const [field, value] of Object.entries(denormalized)) {
    setPatchField(patch, raw, field, value ?? null);
  }
  return patch;
}

function applyArchiveTag(
  patch: JsonObject,
  raw: TaskFrontmatter,
  contract: TasknotesContract
): void {
  const archive = contract.configuration.archive;
  const tag = stringValue(archive?.archived_tag);
  if (!tag) return;
  const tagsField = stringValue(archive?.tags_field)
    ?? contract.specFieldMapping.roleToField.tags;
  const existing = getField(raw, tagsField);
  const tags = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : typeof existing === "string"
      ? existing.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
  if (!tags.includes(tag)) tags.push(tag);
  setPatchField(patch, raw, tagsField, tags);
}

function completedStatus(contract: TasknotesContract) {
  return contract.statuses.find((status) => status.isCompleted);
}

function incompleteStatus(contract: TasknotesContract): string | undefined {
  const candidate = contract.configuration.status.default;
  if (candidate && !contract.configuration.status.completed_values.includes(candidate)) return candidate;
  return contract.statuses.find(
    (status) => !status.isCompleted && !status.isSkipped
  )?.value;
}

function defaultTaskPath(title: string, contract: TasknotesContract): string | undefined {
  if (contract.pathTemplate || contract.pathRuntime) return undefined;
  const filename = slug(title) || "task";
  const folder = contract.pathFolder?.replace(/^\/+|\/+$/g, "") ?? "tasks";
  return `${folder}/${filename}.md`;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function getField(value: JsonObject, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!asObject(current)) return undefined;
    current = asObject(current)?.[segment];
  }
  return current;
}

function setField(value: JsonObject, path: string, fieldValue: unknown): void {
  const segments = path.split(".");
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const child = asObject(current[segment]) ?? {};
    current[segment] = child;
    current = child;
  }
  current[segments.at(-1)!] = fieldValue;
}

function setPatchField(
  patch: JsonObject,
  currentValue: JsonObject,
  path: string,
  fieldValue: unknown
): void {
  const segments = path.split(".");
  const first = segments[0];
  if (segments.length === 1) {
    patch[first] = cloneJson(fieldValue);
    return;
  }
  const existing = asObject(patch[first]) ?? asObject(currentValue[first]);
  const root = existing ? cloneJson(existing) as JsonObject : {};
  let current = root;
  for (const segment of segments.slice(1, -1)) {
    const child = asObject(current[segment]);
    const next = child ? cloneJson(child) as JsonObject : {};
    current[segment] = next;
    current = next;
  }
  const last = segments.at(-1)!;
  if (fieldValue === null) delete current[last];
  else current[last] = cloneJson(fieldValue);
  patch[first] = root;
}

function userFields(contract: TasknotesContract): UserMappedField[] {
  return contract.fields
    .filter((field) => !field.role && field.kind !== "unsupported")
    .map((field) => ({
      id: field.key,
      displayName: field.label,
      key: field.key,
      type:
        field.kind === "number" || field.kind === "integer"
          ? "number"
          : field.kind === "date" || field.kind === "datetime"
            ? "date"
            : field.kind === "boolean"
              ? "boolean"
              : field.kind === "list"
                ? "list"
                : "text",
      ...(isUserFieldDefault(field.defaultValue)
        ? { defaultValue: cloneJson(field.defaultValue) as UserMappedField["defaultValue"] }
        : {})
    }));
}

function isUserFieldDefault(
  value: unknown
): value is string | number | boolean | string[] {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function assertValid(value: { valid: boolean; diagnostics: Array<{ message: string }> }): void {
  if (value.valid) return;
  throw new TasknotesContractError(value.diagnostics[0]?.message ?? "Task operation failed.");
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
