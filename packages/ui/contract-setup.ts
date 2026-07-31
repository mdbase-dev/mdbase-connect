import { parse } from "yaml";

export interface ContractRequirementLike {
  id: string;
  version: string;
}

export interface TypePackProvisionLike {
  manifest: {
    resources: Array<{
      kind: "contract" | "type" | "schema";
      source: string;
      target: string;
    }>;
  };
  resources: Array<{ source: string; document: string }>;
  provides: ContractRequirementLike[];
}

export interface SetupContract extends ContractRequirementLike {
  name?: string;
  description?: string;
  schema: Record<string, unknown>;
  binding_schema?: Record<string, unknown>;
}

export interface SetupType {
  name: string;
  version?: number;
  description?: string;
  revision?: string;
  schema: Record<string, unknown>;
}

export interface SetupField {
  name: string;
  reference: string;
  label: string;
  required: boolean;
  description?: string;
  kind: FieldKind;
  schema: Record<string, unknown>;
}

export interface MappingAssessment {
  level: "valid" | "warning" | "error" | "unmapped";
  label: string;
  message: string;
}

export interface TypeSuggestion {
  type: SetupType;
  fields: Record<string, string>;
  matched: number;
  requiredMatched: number;
  requiredTotal: number;
  score: number;
}

type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "date"
  | "datetime"
  | "advanced";

export function provisionedContract(
  required: ContractRequirementLike,
  provisions: TypePackProvisionLike[]
): SetupContract | undefined {
  for (const provision of provisions) {
    if (!provision.provides.some((value) => sameContract(value, required))) continue;
    const documents = new Map(
      provision.resources.map((resource) => [resource.source, resource.document])
    );
    const targets = new Map(
      provision.manifest.resources.map((resource) => [resource.target, resource])
    );
    for (const resource of provision.manifest.resources) {
      if (resource.kind !== "contract") continue;
      const document = documents.get(resource.source);
      if (!document) continue;
      const frontmatter = parseFrontmatter(document);
      if (frontmatter.id !== required.id || frontmatter.version !== required.version) continue;
      const schema = resolveSchema(frontmatter.record_schema, resource.target, targets, documents);
      if (!schema) continue;
      const binding = resolveSchema(
        frontmatter.binding_schema,
        resource.target,
        targets,
        documents
      );
      return {
        id: required.id,
        version: required.version,
        ...(typeof frontmatter.name === "string" ? { name: frontmatter.name } : {}),
        ...(typeof frontmatter.description === "string"
          ? { description: frontmatter.description }
          : {}),
        schema,
        ...(binding ? { binding_schema: binding } : {})
      };
    }
  }
  return undefined;
}

export function contractFields(contract: SetupContract): SetupField[] {
  const properties = schemaProperties(contract.schema, contract.schema);
  const required = new Set(schemaRequiredFields(contract.schema, contract.schema));
  return Object.entries(properties).map(([name, value]) => {
    const schema = resolvedSchema(contract.schema, record(value));
    return {
      name,
      reference: fieldReference(name),
      label: schemaLabel(name, schema),
      required: required.has(name),
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      kind: schemaKind(schema),
      schema
    };
  });
}

export function typeFields(type: SetupType): SetupField[] {
  const result: SetupField[] = [];
  const visit = (
    current: Record<string, unknown>,
    path: string[],
    parentRequired: boolean,
    depth: number
  ) => {
    if (depth > 12) return;
    const properties = schemaProperties(type.schema, current);
    const required = new Set(schemaRequiredFields(type.schema, current));
    for (const [name, value] of Object.entries(properties)) {
      const fieldPath = [...path, name];
      const schema = resolvedSchema(type.schema, record(value));
      const fieldRequired = parentRequired && required.has(name);
      result.push({
        name,
        reference: referenceForSegments(fieldPath),
        label: schemaLabel(fieldPath.join("."), schema),
        required: fieldRequired,
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
        kind: schemaKind(schema),
        schema
      });
      if (schemaKind(schema) === "object") {
        visit(schema, fieldPath, fieldRequired, depth + 1);
      }
    }
  };
  visit(type.schema, [], true, 0);
  return uniqueBy(result, (field) => field.reference);
}

export function suggestTypes(
  contract: SetupContract,
  types: SetupType[]
): TypeSuggestion[] {
  const fields = contractFields(contract);
  const required = fields.filter((field) => field.required);
  return types
    .filter((type) => Boolean(type.revision))
    .map((type) => {
      const candidates = typeFields(type);
      const mappings = Object.fromEntries(fields.flatMap((field) => {
        const match = matchingField(candidates, field);
        return match ? [[field.reference, match.reference]] : [];
      }));
      const matched = Object.keys(mappings).length;
      const requiredMatched = required.filter((field) => mappings[field.reference]).length;
      const denominator = Math.max(1, fields.length + required.length);
      return {
        type,
        fields: mappings,
        matched,
        requiredMatched,
        requiredTotal: required.length,
        score: (matched + requiredMatched) / denominator
      };
    })
    .sort((left, right) =>
      right.score - left.score || left.type.name.localeCompare(right.type.name)
    );
}

export function assessMapping(
  contractField: SetupField,
  typeField?: SetupField
): MappingAssessment {
  if (!typeField) {
    return contractField.required
      ? {
          level: "error",
          label: "Required",
          message: `Choose which field supplies ${contractField.label}.`
        }
      : {
          level: "unmapped",
          label: "Not shared",
          message: "This optional value will not be shared with the application."
        };
  }
  if (!compatibleKinds(contractField.kind, typeField.kind)) {
    return {
      level: "error",
      label: "Doesn’t match",
      message: `${typeField.label} is ${kindLabel(typeField.kind)}, but ${contractField.label} needs ${kindLabel(contractField.kind)}.`
    };
  }
  const warnings: string[] = [];
  if (contractField.required && !typeField.required) {
    warnings.push("Some existing records may not have this required value.");
  }
  const contractValues = allowedValues(contractField.schema);
  const typeValues = allowedValues(typeField.schema);
  if (contractValues && !typeValues) {
    warnings.push("The existing field allows values the application may not understand.");
  } else if (contractValues && typeValues) {
    const overlap = [...typeValues].filter((value) => contractValues.has(value));
    if (!overlap.length) {
      return {
        level: "error",
        label: "Doesn’t match",
        message: "The two fields allow different values."
      };
    }
    if (overlap.length < typeValues.size) {
      warnings.push("Some existing values are outside the application’s accepted set.");
    }
  }
  return warnings.length
    ? { level: "warning", label: "Review", message: warnings.join(" ") }
    : {
        level: "valid",
        label: "Matches",
        message: `${typeField.label} can supply ${contractField.label}.`
      };
}

export function setupLabel(contract: SetupContract): string {
  return contract.name
    ?? (typeof contract.schema.title === "string" ? contract.schema.title : undefined)
    ?? humanize(contract.id.split(".").at(-1) ?? contract.id);
}

export function propertyFields(schema: Record<string, unknown>): SetupField[] {
  return contractFields({ id: "binding", version: "0.0.0", schema });
}

export function guidedBindingSupported(contract: SetupContract): boolean {
  return !contract.binding_schema
    || propertyFields(contract.binding_schema).every((field) =>
      ["string", "number", "integer", "boolean", "date", "datetime"].includes(field.kind)
    );
}

function resolveSchema(
  wrapper: unknown,
  contractTarget: string,
  targets: Map<string, { source: string }>,
  documents: Map<string, string>
): Record<string, unknown> | undefined {
  const value = record(wrapper);
  if (isRecord(value.value)) return value.value;
  if (typeof value.ref !== "string") return undefined;
  const target = resolveRelativeTarget(contractTarget, value.ref);
  const resource = targets.get(target);
  const document = resource ? documents.get(resource.source) : undefined;
  if (!document) return undefined;
  try {
    const parsed: unknown = JSON.parse(document);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveRelativeTarget(from: string, reference: string): string {
  const parts = [...from.split("/").slice(0, -1), ...reference.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function parseFrontmatter(document: string): Record<string, unknown> {
  const match = document.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return {};
  try {
    return record(parse(match[1]));
  } catch {
    return {};
  }
}

function matchingField(fields: SetupField[], wanted: SetupField): SetupField | undefined {
  const exact = fields.find((field) =>
    field.reference.toLocaleLowerCase() === wanted.reference.toLocaleLowerCase()
    && compatibleKinds(wanted.kind, field.kind)
  );
  if (exact) return exact;
  const named = fields.filter((field) =>
    lastSegment(field.reference).toLocaleLowerCase() === wanted.name.toLocaleLowerCase()
    && compatibleKinds(wanted.kind, field.kind)
  );
  return named.length === 1 ? named[0] : undefined;
}

function schemaProperties(
  root: Record<string, unknown>,
  schema: Record<string, unknown>,
  seen = new Set<Record<string, unknown>>()
): Record<string, unknown> {
  const resolved = resolvedSchema(root, schema);
  if (seen.has(resolved)) return {};
  seen.add(resolved);
  const properties = { ...record(resolved.properties) };
  for (const branch of schemaBranches(resolved)) {
    Object.assign(properties, schemaProperties(root, branch, seen));
  }
  return properties;
}

function schemaRequiredFields(
  root: Record<string, unknown>,
  schema: Record<string, unknown>,
  seen = new Set<Record<string, unknown>>()
): string[] {
  const resolved = resolvedSchema(root, schema);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  return [...new Set([
    ...array(resolved.required).filter((value): value is string => typeof value === "string"),
    ...array(resolved.allOf)
      .filter(isRecord)
      .flatMap((branch) => schemaRequiredFields(root, branch, seen))
  ])];
}

function resolvedSchema(
  root: Record<string, unknown>,
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  let current: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/")) {
    current = record(current)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return isRecord(current) ? current : schema;
}

function schemaBranches(schema: Record<string, unknown>): Record<string, unknown>[] {
  return ["allOf", "anyOf", "oneOf"].flatMap((key) =>
    array(schema[key]).filter(isRecord)
  );
}

function schemaKind(schema: Record<string, unknown>): FieldKind {
  if (Array.isArray(schema.type)) {
    const concrete = schema.type.filter((value) => value !== "null");
    if (concrete.length === 1 && typeof concrete[0] === "string") {
      return schemaKind({ ...schema, type: concrete[0] });
    }
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (alternatives) {
    const kinds = new Set(alternatives
      .filter((value) => record(value).type !== "null")
      .map((value) => schemaKind(record(value))));
    if (kinds.size === 1) return [...kinds][0];
  }
  if (schema.type === "string" && schema.format === "date") return "date";
  if (schema.type === "string" && schema.format === "date-time") return "datetime";
  if (["string", "number", "integer", "boolean", "array", "object"].includes(String(schema.type))) {
    return schema.type as FieldKind;
  }
  if (typeof schema.const === "string"
      || (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string"))) {
    return "string";
  }
  if (typeof schema.const === "number") return Number.isInteger(schema.const) ? "integer" : "number";
  if (typeof schema.const === "boolean") return "boolean";
  return "advanced";
}

function compatibleKinds(contract: FieldKind, type: FieldKind): boolean {
  return (contract !== "advanced" && type !== "advanced" && contract === type)
    || (contract === "number" && type === "integer")
    || (contract === "string" && (type === "date" || type === "datetime"));
}

function allowedValues(schema: Record<string, unknown>): Set<string> | undefined {
  if ("const" in schema) return new Set([JSON.stringify(schema.const)]);
  return Array.isArray(schema.enum)
    ? new Set(schema.enum.map((value) => JSON.stringify(value)))
    : undefined;
}

function schemaLabel(fallback: string, schema: Record<string, unknown>): string {
  return typeof schema.title === "string" && schema.title.trim()
    ? schema.title
    : humanize(fallback);
}

function humanize(value: string): string {
  const result = value
    .replaceAll(/[._-]+/gu, " ")
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .trim();
  return result ? result[0].toLocaleUpperCase() + result.slice(1) : value;
}

function kindLabel(kind: FieldKind): string {
  return ({
    string: "text",
    number: "a number",
    integer: "a whole number",
    boolean: "a yes/no value",
    array: "a list",
    object: "a group of values",
    date: "a date",
    datetime: "a date and time",
    advanced: "a complex value"
  } satisfies Record<FieldKind, string>)[kind];
}

function referenceForSegments(segments: string[]): string {
  return segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment))
    ? segments.join(".")
    : `/${segments.map((segment) =>
        segment.replaceAll("~", "~0").replaceAll("/", "~1")
      ).join("/")}`;
}

function fieldReference(name: string): string {
  return referenceForSegments([name]);
}

function lastSegment(reference: string): string {
  if (reference.startsWith("/")) {
    return reference.split("/").at(-1)?.replaceAll("~1", "/").replaceAll("~0", "~") ?? reference;
  }
  return reference.split(".").at(-1) ?? reference;
}

function sameContract(left: ContractRequirementLike, right: ContractRequirementLike): boolean {
  return left.id === right.id && left.version === right.version;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}
