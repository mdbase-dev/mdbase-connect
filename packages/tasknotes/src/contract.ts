import type {
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionTypeDescriptor,
  JsonObject,
  SyncCollectionResources
} from "@mdbase/connect-protocol";
import {
  ALL_FIELD_ROLES,
  buildSpecFieldMapping
} from "@tasknotes/model/config";
import {
  DEFAULT_FIELD_MAPPING,
  DEFAULT_PRIORITIES,
  DEFAULT_STATUSES
} from "@tasknotes/model/defaults";
import type {
  FieldMapping,
  FieldRole,
  PriorityConfig,
  SpecFieldMapping,
  StatusConfig
} from "@tasknotes/model/types";

export const TASKNOTES_TASK_CONTRACT = "tasknotes.task";

export interface TasknotesContractConfiguration extends JsonObject {
  contract: typeof TASKNOTES_TASK_CONTRACT;
  version: number;
  field_roles: Record<string, string>;
  status: JsonObject & {
    values?: string[];
    completed_values: string[];
    skipped_values?: string[];
    default?: string;
    definitions?: JsonObject[];
  };
  priority?: JsonObject & {
    values?: string[];
    default?: string;
    definitions?: JsonObject[];
  };
  title?: JsonObject & {
    storage?: "filename" | "frontmatter";
    filename_format?: string;
    custom_filename_template?: string;
  };
  recurrence?: JsonObject;
  occurrences?: JsonObject;
  links?: JsonObject;
  archive?: JsonObject;
  time_tracking?: JsonObject;
  templating?: JsonObject;
  profiles?: string[];
  capabilities?: string[];
}

export type TaskFieldKind =
  | "text"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "datetime"
  | "list"
  | "enum"
  | "unsupported";

export interface TaskFieldDefinition {
  key: string;
  role?: string;
  label: string;
  description?: string;
  kind: TaskFieldKind;
  required: boolean;
  readOnly: boolean;
  enumValues?: string[];
  defaultValue?: unknown;
  itemKind?: Exclude<TaskFieldKind, "list">;
  schema: JsonObject;
}

export interface TasknotesContract {
  descriptor: CollectionContractDescriptor;
  configuration: TasknotesContractConfiguration;
  typeName: string;
  type: CollectionTypeDescriptor;
  schema: JsonObject;
  fields: TaskFieldDefinition[];
  fieldMapping: FieldMapping;
  specFieldMapping: SpecFieldMapping;
  statuses: StatusConfig[];
  priorities: PriorityConfig[];
  pathFolder?: string;
  pathTemplate?: string;
  pathRuntime?: string;
  titleStorage: "filename" | "frontmatter";
  profiles: string[];
  capabilities: string[];
}

export function resolveTasknotesContract(description: CollectionDescription): TasknotesContract {
  return resolveContract(description.types, description.contracts);
}

export function resolveTasknotesSyncContract(resources: SyncCollectionResources): TasknotesContract {
  return resolveContract(resources.types, resources.contracts);
}

function resolveContract(
  types: CollectionDescription["types"],
  contracts: CollectionDescription["contracts"]
): TasknotesContract {
  const descriptor = contracts.find((contract) => contract.id === TASKNOTES_TASK_CONTRACT);
  if (!descriptor) {
    throw new TasknotesContractError("TaskNotes task contract is not available in this collection.");
  }
  const configuration = parseConfiguration(descriptor.configuration);
  const type = types.find((candidate) => candidate.name === descriptor.type_name);
  if (!type) {
    throw new TasknotesContractError(
      `TaskNotes contract refers to missing type "${descriptor.type_name}".`
    );
  }

  const schema = schemaValue(type.schema);
  const properties = asObject(schema.properties) ?? {};
  const collection = asObject(type.collection);
  const path = asObject(collection?.path);
  const display = asObject(collection?.display);
  const inferredMapping = buildSpecFieldMapping(
    properties,
    stringValue(display?.name_field)
  );
  const specFieldMapping = applyDeclaredRoles(
    inferredMapping,
    configuration.field_roles,
    configuration.status.completed_values
  );
  const fieldMapping = tasknotesFieldMapping(configuration.field_roles, specFieldMapping);
  const statuses = statusDefinitions(configuration, properties, specFieldMapping);
  const priorities = priorityDefinitions(configuration, properties, specFieldMapping);

  return {
    descriptor,
    configuration,
    typeName: descriptor.type_name,
    type,
    schema,
    fields: schemaFields(properties, schema, configuration.field_roles),
    fieldMapping,
    specFieldMapping,
    statuses,
    priorities,
    pathFolder: stringValue(path?.folder),
    pathTemplate: stringValue(path?.template) ?? stringValue(path?.pattern),
    pathRuntime: stringValue(path?.runtime),
    titleStorage: configuration.title?.storage === "filename" ? "filename" : "frontmatter",
    profiles: stringArray(configuration.profiles),
    capabilities: stringArray(configuration.capabilities)
  };
}

function parseConfiguration(value: JsonObject): TasknotesContractConfiguration {
  const roles = asObject(value.field_roles);
  const status = asObject(value.status);
  const completedValues = status?.completed_values;
  if (
    value.contract !== TASKNOTES_TASK_CONTRACT
    || typeof value.version !== "number"
    || !roles
    || !status
    || !Array.isArray(completedValues)
    || completedValues.length === 0
    || !completedValues.every((item) => typeof item === "string" && item.length > 0)
    || !Object.values(roles).every(
      (field) => typeof field === "string" && validFieldPath(field)
    )
    || (
      status.default !== undefined
      && (typeof status.default !== "string" || status.default.length === 0)
    )
  ) {
    throw new TasknotesContractError("The TaskNotes task contract is malformed.");
  }
  return value as TasknotesContractConfiguration;
}

function applyDeclaredRoles(
  inferred: SpecFieldMapping,
  roles: Record<string, string>,
  completedStatuses: string[]
): SpecFieldMapping {
  const roleToField: SpecFieldMapping["roleToField"] = { ...inferred.roleToField };
  for (const role of ALL_FIELD_ROLES) {
    const declared = roles[role];
    if (declared) roleToField[role as keyof typeof roleToField] = declared;
  }
  const fieldToRole: Record<string, FieldRole> = {};
  for (const role of ALL_FIELD_ROLES) {
    fieldToRole[roleToField[role as keyof typeof roleToField]] = role;
  }
  return {
    roleToField,
    fieldToRole,
    displayNameKey: roleToField.title,
    completedStatuses: [...completedStatuses]
  };
}

function tasknotesFieldMapping(
  roles: Record<string, string>,
  spec: SpecFieldMapping
): FieldMapping {
  const mapping = { ...DEFAULT_FIELD_MAPPING };
  for (const key of Object.keys(mapping) as Array<keyof FieldMapping>) {
    const declared = roles[key];
    if (declared) mapping[key] = declared;
  }
  for (const role of ALL_FIELD_ROLES) {
    if (role in mapping) {
      mapping[role as keyof FieldMapping] =
        spec.roleToField[role as keyof typeof spec.roleToField];
    }
  }
  return mapping;
}

function statusDefinitions(
  configuration: TasknotesContractConfiguration,
  properties: JsonObject,
  mapping: SpecFieldMapping
): StatusConfig[] {
  const policy = configuration.status;
  const schema = asObject(properties[mapping.roleToField.status]);
  const values = firstStrings(policy.values, schema?.enum, [
    policy.default,
    ...policy.completed_values,
    ...stringArray(policy.skipped_values)
  ]);
  const definitions = definitionMap(policy.definitions);
  const completed = new Set(policy.completed_values);
  const skipped = new Set(stringArray(policy.skipped_values));
  return values.map((value, index) => {
    const definition = definitions.get(value);
    const fallback = DEFAULT_STATUSES.find((status) => status.value === value);
    return {
      id: stringValue(definition?.id) ?? fallback?.id ?? value,
      value,
      label: stringValue(definition?.label) ?? fallback?.label ?? humanize(value),
      color: stringValue(definition?.color) ?? fallback?.color ?? "",
      ...(stringValue(definition?.icon) ? { icon: stringValue(definition?.icon) } : {}),
      isCompleted: booleanValue(definition?.is_completed) ?? completed.has(value),
      isSkipped: booleanValue(definition?.is_skipped) ?? skipped.has(value),
      excludeFromCycle:
        booleanValue(definition?.exclude_from_cycle) ?? fallback?.excludeFromCycle ?? false,
      ...(stringValue(definition?.next_status)
        ? { nextStatus: stringValue(definition?.next_status) }
        : {}),
      order: numberValue(definition?.order) ?? fallback?.order ?? index,
      autoArchive:
        booleanValue(definition?.auto_archive) ?? fallback?.autoArchive ?? false,
      autoArchiveDelay:
        numberValue(definition?.auto_archive_delay_minutes)
        ?? fallback?.autoArchiveDelay
        ?? 0
    };
  }).sort((left, right) => left.order - right.order);
}

function priorityDefinitions(
  configuration: TasknotesContractConfiguration,
  properties: JsonObject,
  mapping: SpecFieldMapping
): PriorityConfig[] {
  const policy = configuration.priority;
  const schema = asObject(properties[mapping.roleToField.priority]);
  const values = firstStrings(policy?.values, schema?.enum, [policy?.default]);
  const definitions = definitionMap(policy?.definitions);
  return values.map((value, index) => {
    const definition = definitions.get(value);
    const fallback = DEFAULT_PRIORITIES.find((priority) => priority.value === value);
    return {
      id: stringValue(definition?.id) ?? fallback?.id ?? value,
      value,
      label: stringValue(definition?.label) ?? fallback?.label ?? humanize(value),
      color: stringValue(definition?.color) ?? fallback?.color ?? "",
      ...(stringValue(definition?.icon) ? { icon: stringValue(definition?.icon) } : {}),
      weight: numberValue(definition?.weight) ?? fallback?.weight ?? index
    };
  }).sort((left, right) => left.weight - right.weight);
}

function schemaFields(
  properties: JsonObject,
  schema: JsonObject,
  roles: Record<string, string>
): TaskFieldDefinition[] {
  const required = new Set(stringArray(schema.required));
  const fieldRoles = new Map(Object.entries(roles).map(([role, field]) => [field, role]));
  return Object.entries(properties).map(([key, rawSchema]) => {
    const original = asObject(rawSchema) ?? {};
    const resolved = preferredSchema(original);
    const enumValues = stringArray(resolved.enum);
    const kind = fieldKind(resolved, enumValues);
    const defaultValue = resolved.default;
    return {
      key,
      ...(fieldRoles.get(key) ? { role: fieldRoles.get(key) } : {}),
      label: stringValue(resolved.title) ?? humanize(fieldRoles.get(key) ?? key),
      ...(stringValue(resolved.description)
        ? { description: stringValue(resolved.description) }
        : {}),
      kind,
      required: required.has(key),
      readOnly: resolved.readOnly === true,
      ...(enumValues.length > 0 ? { enumValues } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(kind === "list"
        ? { itemKind: listItemKind(resolved.items) }
        : {}),
      schema: original
    };
  });
}

function listItemKind(value: unknown): Exclude<TaskFieldKind, "list"> {
  const kind = fieldKind(preferredSchema(asObject(value) ?? {}), []);
  return kind === "list" ? "unsupported" : kind;
}

function preferredSchema(schema: JsonObject): JsonObject {
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  return variants
    .map(asObject)
    .find((candidate) => candidate && candidate.type !== "null")
    ?? schema;
}

function fieldKind(schema: JsonObject, enumValues: string[]): TaskFieldKind {
  if (enumValues.length > 0) return "enum";
  if (schema.format === "date") return "date";
  if (schema.format === "date-time") return "datetime";
  if (schema.type === "string") return "text";
  if (schema.type === "number") return "number";
  if (schema.type === "integer") return "integer";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return "list";
  return "unsupported";
}

function schemaValue(schema: JsonObject): JsonObject {
  return asObject(schema.value) ?? schema;
}

function definitionMap(value: unknown): Map<string, JsonObject> {
  const definitions = new Map<string, JsonObject>();
  if (!Array.isArray(value)) return definitions;
  for (const entry of value) {
    const definition = asObject(entry);
    const key = stringValue(definition?.value);
    if (definition && key) definitions.set(key, definition);
  }
  return definitions;
}

function firstStrings(...candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    const values = stringArray(candidate);
    if (values.length > 0) return [...new Set(values)];
  }
  return [];
}

function validFieldPath(value: string): boolean {
  return value.split(".").every(
    (part) =>
      part.length > 0
      && part !== "__proto__"
      && part !== "prototype"
      && part !== "constructor"
  );
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class TasknotesContractError extends Error {}
