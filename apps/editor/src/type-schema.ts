import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import type { NoteSummary } from "./model";

export type TypeFieldKind = "string" | "number" | "integer" | "boolean" | "array" | "object" | "date" | "datetime" | "advanced";
export type TypeSchemaPath = string[];
export type TypeValuePath = Array<string | "[]">;
export type TypeLinkFormat = "wikilink" | "markdown" | "path" | "any";
export type TypeUniqueScope = "collection" | "type" | "path_glob";

export interface TypeFieldConstraints {
  constant?: unknown;
  choices?: string[];
  defaultValue?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  additionalProperties?: boolean;
}

export interface TypeSchemaNode {
  path: TypeSchemaPath;
  valuePath: TypeValuePath;
  kind: TypeFieldKind;
  description?: string;
  fields: TypeFieldDefinition[];
  item?: TypeSchemaNode;
  constraints: TypeFieldConstraints;
  advancedKeys: string[];
  raw: Record<string, unknown>;
}

export interface TypeFieldDefinition extends TypeSchemaNode {
  name: string;
  required: boolean;
}

export interface VisualTypeDefinition {
  name: string;
  description: string;
  pathGlob?: string;
  pathGlobs: string[];
  fieldsPresent: string[];
  advancedMatchKeys: string[];
  advancedMatch: boolean;
  fields: TypeFieldDefinition[];
  collection: TypeCollectionDefinition;
}

export interface TypeCollectionDefinition {
  display: {
    nameField?: string;
    descriptionField?: string;
    icon?: string;
    colorField?: string;
  };
  readDefaults: Array<{ field: string; value: unknown }>;
  links: TypeLinkRuleDefinition[];
  unique: TypeUniqueRuleDefinition[];
  path: {
    pattern?: string;
    template?: string;
    folder?: string;
    advancedKeys: string[];
  };
  advancedKeys: string[];
}

export interface TypeLinkRuleDefinition {
  field: string;
  targetTypes: string[];
  validateExists: boolean;
  format?: TypeLinkFormat;
  advancedKeys: string[];
}

export interface TypeUniqueRuleDefinition {
  sourceIndex: number;
  field: string;
  scope?: TypeUniqueScope;
  pathGlob?: string;
  advancedKeys: string[];
}

export interface TypeImpact {
  addedFields: string[];
  removedFields: string[];
  changedFields: string[];
  newlyRequired: string[];
  affectedNotes: number;
  membership: TypeMembershipImpact;
  missingRequired: Array<{ field: string; count: number }>;
  definitionChanges: string[];
  collectionChanges: string[];
}

export interface TypeMembershipImpact {
  current: number;
  next?: number;
  addedPaths: string[];
  removedPaths: string[];
  overlapping: number;
  complete: boolean;
}

interface ParsedTypeSource {
  document: Document;
  tail: string;
  value: Record<string, unknown>;
}

const SCHEMA_ROOT = ["schema", "value"];
const KIND_KEYS = [
  "type", "const", "enum", "format", "items", "properties", "required", "additionalProperties",
  "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties",
  "maxProperties", "$ref", "$defs", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
  "dependentRequired", "dependentSchemas", "patternProperties", "prefixItems", "contains", "default", "examples"
];

export function readVisualType(source: string): VisualTypeDefinition {
  const { value } = parseTypeSource(source);
  const schema = record(record(value.schema).value);
  const match = record(value.match);
  const pathGlobs = typeof match.path_glob === "string"
    ? [match.path_glob]
    : array(match.path_glob).filter((item): item is string => typeof item === "string");
  const fieldsPresent = array(match.fields_present).filter((item): item is string => typeof item === "string");
  const advancedMatchKeys = Object.keys(match).filter((key) => {
    if (key === "path_glob") {
      return typeof match.path_glob !== "string"
        && !(Array.isArray(match.path_glob) && match.path_glob.every((item) => typeof item === "string"));
    }
    if (key === "fields_present") {
      return !(Array.isArray(match.fields_present) && match.fields_present.every((item) => typeof item === "string"));
    }
    return true;
  });
  return {
    name: typeof value.name === "string" ? value.name : "",
    description: typeof value.description === "string" ? value.description : "",
    ...(pathGlobs[0] ? { pathGlob: pathGlobs[0] } : {}),
    pathGlobs,
    fieldsPresent,
    advancedMatchKeys,
    advancedMatch: advancedMatchKeys.length > 0,
    fields: readObjectFields(schema, [], []),
    collection: readTypeCollection(value.collection)
  };
}

export function updateTypeIdentity(source: string, field: "name" | "description", value: string): string {
  return mutate(source, (document) => document.setIn([field], value));
}

export function updateTypePathGlob(source: string, value: string): string {
  return updateTypePathGlobs(source, value.trim() ? [value] : []);
}

export function updateTypePathGlobs(source: string, values: string[]): string {
  const pathGlobs = normalizedStrings(values);
  return updateMatchList(source, "path_glob", pathGlobs, true);
}

export function updateTypeFieldsPresent(source: string, values: string[]): string {
  return updateMatchList(source, "fields_present", normalizedStrings(values), false);
}

export function updateTypeCollectionDisplay(
  source: string,
  key: "name_field" | "description_field" | "icon" | "color_field",
  value: string
): string {
  return mutate(source, (document) => {
    if (value === "") deleteInAndPrune(document, ["collection", "display", key]);
    else document.setIn(["collection", "display", key], value);
  });
}

export function addTypeReadDefault(source: string, field: string, value: unknown): string {
  return mutate(source, (document) => {
    if (document.getIn(["collection", "read_defaults", field]) !== undefined) {
      throw new Error(`A read default for “${field}” already exists.`);
    }
    document.setIn(["collection", "read_defaults", field], value);
  });
}

export function renameTypeReadDefault(source: string, from: string, to: string): string {
  return renameCollectionMapEntry(source, ["collection", "read_defaults"], from, to, "read default");
}

export function setTypeReadDefault(source: string, field: string, value: unknown): string {
  return mutate(source, (document) => document.setIn(["collection", "read_defaults", field], value));
}

export function removeTypeReadDefault(source: string, field: string): string {
  return mutate(source, (document) => deleteInAndPrune(document, ["collection", "read_defaults", field]));
}

export function addTypeLinkRule(source: string, field: string): string {
  return mutate(source, (document) => {
    if (document.getIn(["collection", "links", field]) !== undefined) {
      throw new Error(`A link rule for “${field}” already exists.`);
    }
    document.setIn(["collection", "links", field], {});
  });
}

export function renameTypeLinkRule(source: string, from: string, to: string): string {
  return renameCollectionMapEntry(source, ["collection", "links"], from, to, "link rule");
}

export function setTypeLinkRule(
  source: string,
  field: string,
  key: "target_type" | "validate_exists" | "format",
  value: unknown
): string {
  return mutate(source, (document) => {
    const path = ["collection", "links", field, key];
    if (value === undefined || value === "") document.deleteIn(path);
    else document.setIn(path, value);
  });
}

export function setTypeLinkTargets(source: string, field: string, targetTypes: string[]): string {
  const values = normalizedStrings(targetTypes);
  return setTypeLinkRule(source, field, "target_type", values.length > 1 ? values : values[0]);
}

export function removeTypeLinkRule(source: string, field: string): string {
  return mutate(source, (document) => deleteInAndPrune(document, ["collection", "links", field]));
}

export function addTypeUniqueRule(source: string, field: string): string {
  return mutate(source, (document) => {
    const rules = document.getIn(["collection", "unique"]);
    if (isSeq(rules)) rules.add({ field, scope: "type" });
    else document.setIn(["collection", "unique"], [{ field, scope: "type" }]);
  });
}

export function setTypeUniqueRule(
  source: string,
  index: number,
  key: "field" | "scope" | "path_glob",
  value: string | undefined
): string {
  return mutate(source, (document) => {
    const path = ["collection", "unique", index, key];
    if (value === undefined || value === "") document.deleteIn(path);
    else document.setIn(path, value);
    if (key === "scope" && value !== "path_glob") {
      document.deleteIn(["collection", "unique", index, "path_glob"]);
    }
  });
}

export function removeTypeUniqueRule(source: string, index: number): string {
  return mutate(source, (document) => deleteInAndPrune(document, ["collection", "unique", index]));
}

export function updateTypePathPolicy(
  source: string,
  key: "pattern" | "template" | "folder",
  value: string
): string {
  return mutate(source, (document) => {
    if (value === "") deleteInAndPrune(document, ["collection", "path", key]);
    else document.setIn(["collection", "path", key], value);
  });
}

function updateMatchList(source: string, key: "path_glob" | "fields_present", values: string[], scalarWhenSingle: boolean): string {
  return mutate(source, (document) => {
    if (values.length) {
      document.setIn(["match", key], scalarWhenSingle && values.length === 1 ? values[0] : values);
      return;
    }
    document.deleteIn(["match", key]);
    const match = document.getIn(["match"]);
    if (isMap(match) && match.items.length === 0) document.deleteIn(["match"]);
  });
}

export function addTypeField(source: string, parentPath: TypeSchemaPath = []): string {
  const visual = readVisualType(source);
  const parent = parentPath.length ? findSchemaNode(visual.fields, parentPath) : undefined;
  const existing = new Set((parent ? parent.fields : visual.fields).map((field) => field.name));
  let index = 1;
  let name = "field";
  while (existing.has(name)) name = `field-${++index}`;
  return mutate(source, (document) => {
    document.setIn([...SCHEMA_ROOT, ...parentPath, "properties", name], { type: "string" });
  });
}

export function renameTypeField(source: string, pathOrName: TypeSchemaPath | string, to: string): string {
  const path = fieldPath(pathOrName);
  const name = to.trim();
  const from = path.at(-1) ?? "";
  if (!name || name === from) return source;
  const visual = readVisualType(source);
  const parentPath = objectParentPath(path);
  const siblings = parentPath.length ? findSchemaNode(visual.fields, parentPath)?.fields ?? [] : visual.fields;
  if (siblings.some((field) => field.name === name)) throw new Error(`A field named “${name}” already exists.`);
  return mutate(source, (document) => {
    const definition = document.getIn([...SCHEMA_ROOT, ...path]);
    const nextPath = [...path.slice(0, -1), name];
    document.setIn([...SCHEMA_ROOT, ...nextPath], definition);
    document.deleteIn([...SCHEMA_ROOT, ...path]);
    const required = requiredFields(document, parentPath).map((field) => field === from ? name : field);
    setRequiredFields(document, parentPath, required);
    renameContractFieldReferences(document, schemaValuePath(path), schemaValuePath(nextPath));
  });
}

export function setTypeFieldKind(source: string, pathOrName: TypeSchemaPath | string, kind: Exclude<TypeFieldKind, "advanced">): string {
  const path = fieldPath(pathOrName);
  return mutate(source, (document) => replaceSchemaKind(document, path, kind));
}

export function setTypeListItemKind(source: string, arrayPath: TypeSchemaPath, kind: Exclude<TypeFieldKind, "advanced">): string {
  return mutate(source, (document) => replaceSchemaKind(document, [...arrayPath, "items"], kind));
}

export function typeFieldConversionImpact(source: string, pathOrName: TypeSchemaPath | string, kind: Exclude<TypeFieldKind, "advanced">): string[] {
  const path = fieldPath(pathOrName);
  const definition = schemaAtPath(source, path);
  const currentKind = fieldKind(definition);
  if (currentKind === kind) return [];
  return KIND_KEYS.flatMap((key) => {
    if (!(key in definition) || key === "type") return [];
    if (key === "format" && ((currentKind === "date" && kind === "datetime") || (currentKind === "datetime" && kind === "date"))) return [];
    return [constraintLabel(key)];
  }).filter((label, index, labels) => labels.indexOf(label) === index);
}

export function setTypeFieldRequired(source: string, pathOrName: TypeSchemaPath | string, required: boolean): string {
  const path = fieldPath(pathOrName);
  const parentPath = objectParentPath(path);
  const name = path.at(-1) ?? "";
  return mutate(source, (document) => {
    const fields = new Set(requiredFields(document, parentPath));
    if (required) fields.add(name);
    else fields.delete(name);
    setRequiredFields(document, parentPath, [...fields]);
  });
}

export function setTypeFieldDescription(source: string, pathOrName: TypeSchemaPath | string, description: string): string {
  return setTypeFieldConstraint(source, pathOrName, "description", description);
}

export function setTypeFieldConstraint(source: string, pathOrName: TypeSchemaPath | string, key: string, value: unknown): string {
  const path = fieldPath(pathOrName);
  return mutate(source, (document) => {
    if (value === undefined || value === "") document.deleteIn([...SCHEMA_ROOT, ...path, key]);
    else document.setIn([...SCHEMA_ROOT, ...path, key], value);
  });
}

export function setTypeFieldChoices(source: string, pathOrName: TypeSchemaPath | string, choices: string[]): string {
  const values = choices.map((choice) => choice.trim()).filter(Boolean);
  return setTypeFieldConstraint(source, pathOrName, "enum", values.length ? [...new Set(values)] : undefined);
}

export function removeTypeField(source: string, pathOrName: TypeSchemaPath | string): string {
  const path = fieldPath(pathOrName);
  const parentPath = objectParentPath(path);
  const name = path.at(-1) ?? "";
  return mutate(source, (document) => {
    document.deleteIn([...SCHEMA_ROOT, ...path]);
    setRequiredFields(document, parentPath, requiredFields(document, parentPath).filter((field) => field !== name));
  });
}

export function typeFieldPathLabel(path: TypeSchemaPath): string {
  let label = "";
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === "properties" && path[index + 1]) {
      label += `${label ? "." : ""}${path[index + 1]}`;
      index += 1;
    } else if (path[index] === "items") {
      label += "[]";
    }
  }
  return label || "field";
}

export function typeImpact(
  previousSource: string | undefined,
  nextSource: string,
  notes: NoteSummary[],
  currentTypeName?: string,
  explicitTypeKeys: string[] = ["type", "types"]
): TypeImpact {
  const previousDefinition = previousSource ? readVisualType(previousSource) : undefined;
  const previous = previousDefinition ?? { name: "", description: "", advancedMatch: false, fields: [] };
  const next = readVisualType(nextSource);
  const before = flattenFields(previous.fields);
  const after = flattenFields(next.fields);
  const addedFields = [...after.keys()].filter((name) => !before.has(name));
  const removedFields = [...before.keys()].filter((name) => !after.has(name));
  const changedFields = [...after].filter(([name, field]) => {
    const previousField = before.get(name);
    return previousField && fieldSignature(previousField) !== fieldSignature(field);
  }).map(([name]) => name);
  const newlyRequired = [...after].filter(([name, field]) => field.required && !before.get(name)?.required).map(([name]) => name);
  const previousNames = [currentTypeName, previous.name].filter((name): name is string => Boolean(name));
  const currentMembers = currentTypeName
    ? previousDefinition && !previousDefinition.advancedMatch
      ? notes.filter((note) => noteMatchesVisualType(note, previousDefinition, explicitTypeKeys))
      : notes.filter((note) => note.types.some((name) => sameTypeName(name, currentTypeName)))
    : [];
  const prospectiveMembers = next.advancedMatch
    ? undefined
    : notes.filter((note) => noteMatchesVisualType(note, next, explicitTypeKeys));
  const currentPaths = new Set(currentMembers.map((note) => note.path));
  const prospectivePaths = new Set(prospectiveMembers?.map((note) => note.path) ?? []);
  const membership: TypeMembershipImpact = {
    current: currentMembers.length,
    ...(prospectiveMembers ? { next: prospectiveMembers.length } : {}),
    addedPaths: prospectiveMembers
      ? prospectiveMembers.filter((note) => !currentPaths.has(note.path)).map((note) => note.path)
      : [],
    removedPaths: prospectiveMembers
      ? currentMembers.filter((note) => !prospectivePaths.has(note.path)).map((note) => note.path)
      : [],
    overlapping: prospectiveMembers
      ? prospectiveMembers.filter((note) => note.types.some((name) =>
        !previousNames.some((previousName) => sameTypeName(name, previousName))
        && !sameTypeName(name, next.name)
      )).length
      : 0,
    complete: Boolean(prospectiveMembers)
  };
  const affected = prospectiveMembers ?? currentMembers;
  return {
    addedFields,
    removedFields,
    changedFields,
    newlyRequired,
    affectedNotes: affected.length,
    membership,
    missingRequired: newlyRequired.map((fieldName) => {
      const field = after.get(fieldName)!;
      return { field: fieldName, count: affected.filter((note) => missingRequiredValue(note.frontmatter, field.valuePath)).length };
    }).filter((item) => item.count > 0),
    definitionChanges: definitionChanges(previousSource, nextSource),
    collectionChanges: typeCollectionChanges(previousSource, nextSource)
  };
}

function readTypeCollection(value: unknown): TypeCollectionDefinition {
  const collection = record(value);
  const display = record(collection.display);
  const linksValue = record(collection.links);
  const uniqueValue = array(collection.unique);
  const path = record(collection.path);
  const linkFormats: TypeLinkFormat[] = ["wikilink", "markdown", "path", "any"];
  const uniqueScopes: TypeUniqueScope[] = ["collection", "type", "path_glob"];

  const links = Object.entries(linksValue).flatMap(([field, rawRule]) => {
    if (!isRecord(rawRule)) return [];
    const targetType = rawRule.target_type;
    const targetTypes = typeof targetType === "string"
      ? [targetType]
      : array(targetType).filter((item): item is string => typeof item === "string");
    const advancedKeys = Object.keys(rawRule).filter((key) => {
      if (key === "target_type") {
        return typeof targetType !== "string"
          && !(Array.isArray(targetType) && targetType.every((item) => typeof item === "string"));
      }
      if (key === "validate_exists") return typeof rawRule.validate_exists !== "boolean";
      if (key === "format") return !linkFormats.includes(rawRule.format as TypeLinkFormat);
      return true;
    });
    return [{
      field,
      targetTypes,
      validateExists: rawRule.validate_exists === true,
      ...(linkFormats.includes(rawRule.format as TypeLinkFormat) ? { format: rawRule.format as TypeLinkFormat } : {}),
      advancedKeys
    }];
  });

  const unique = uniqueValue.flatMap((rawRule, sourceIndex) => {
    if (!isRecord(rawRule) || typeof rawRule.field !== "string") return [];
    const advancedKeys = Object.keys(rawRule).filter((key) => {
      if (key === "field") return typeof rawRule.field !== "string";
      if (key === "scope") return !uniqueScopes.includes(rawRule.scope as TypeUniqueScope);
      if (key === "path_glob") return typeof rawRule.path_glob !== "string";
      return true;
    });
    return [{
      sourceIndex,
      field: rawRule.field,
      ...(uniqueScopes.includes(rawRule.scope as TypeUniqueScope) ? { scope: rawRule.scope as TypeUniqueScope } : {}),
      ...(typeof rawRule.path_glob === "string" ? { pathGlob: rawRule.path_glob } : {}),
      advancedKeys
    }];
  });

  const supportedCollectionKeys = new Set(["display", "read_defaults", "links", "unique", "path"]);
  const advancedKeys = Object.keys(collection).filter((key) => !supportedCollectionKeys.has(key));
  const displayKeys = new Set(["name_field", "description_field", "icon", "color_field"]);
  for (const key of Object.keys(display)) {
    if (!displayKeys.has(key) || typeof display[key] !== "string") advancedKeys.push(`display.${key}`);
  }
  if ("display" in collection && !isRecord(collection.display)) advancedKeys.push("display with an unsupported value");
  if ("read_defaults" in collection && !isRecord(collection.read_defaults)) advancedKeys.push("read defaults with an unsupported value");
  if ("links" in collection && (!isRecord(collection.links) || Object.keys(linksValue).length !== links.length)) {
    advancedKeys.push("links with unsupported values");
  }
  if ("unique" in collection && (!Array.isArray(collection.unique) || uniqueValue.length !== unique.length)) {
    advancedKeys.push("unique rules with unsupported values");
  }

  return {
    display: {
      ...(typeof display.name_field === "string" ? { nameField: display.name_field } : {}),
      ...(typeof display.description_field === "string" ? { descriptionField: display.description_field } : {}),
      ...(typeof display.icon === "string" ? { icon: display.icon } : {}),
      ...(typeof display.color_field === "string" ? { colorField: display.color_field } : {})
    },
    readDefaults: Object.entries(record(collection.read_defaults)).map(([field, defaultValue]) => ({ field, value: defaultValue })),
    links,
    unique,
    path: {
      ...(typeof path.pattern === "string" ? { pattern: path.pattern } : {}),
      ...(typeof path.template === "string" ? { template: path.template } : {}),
      ...(typeof path.folder === "string" ? { folder: path.folder } : {}),
      advancedKeys: Object.keys(path).filter((key) => {
        if (key === "pattern" || key === "template" || key === "folder") return typeof path[key] !== "string";
        return true;
      })
    },
    advancedKeys: [...new Set(advancedKeys)]
  };
}

function readObjectFields(schema: Record<string, unknown>, objectPath: TypeSchemaPath, valuePath: TypeValuePath): TypeFieldDefinition[] {
  const properties = record(schema.properties);
  const required = new Set(array(schema.required).filter((item): item is string => typeof item === "string"));
  return Object.entries(properties).map(([name, definition]) => {
    const path = [...objectPath, "properties", name];
    return {
      name,
      required: required.has(name),
      ...readSchemaNode(record(definition), path, [...valuePath, name])
    };
  });
}

function readSchemaNode(schema: Record<string, unknown>, path: TypeSchemaPath, valuePath: TypeValuePath): TypeSchemaNode {
  const kind = fieldKind(schema);
  const fields = kind === "object" ? readObjectFields(schema, path, valuePath) : [];
  const itemSchema = kind === "array" ? record(schema.items) : undefined;
  return {
    path,
    valuePath,
    kind,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    fields,
    ...(itemSchema ? { item: readSchemaNode(itemSchema, [...path, "items"], [...valuePath, "[]"]) } : {}),
    constraints: fieldConstraints(schema),
    advancedKeys: advancedSchemaKeys(schema, kind),
    raw: schema
  };
}

function advancedSchemaKeys(schema: Record<string, unknown>, kind: TypeFieldKind): string[] {
  const supported = new Set(["description"]);
  if (kind !== "advanced" && typeof schema.type === "string") supported.add("type");
  if (kind === "string") {
    ["minLength", "maxLength", "pattern"].forEach((key) => supported.add(key));
    if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) supported.add("enum");
  }
  if (kind === "date" || kind === "datetime") supported.add("format");
  if (kind === "number" || kind === "integer") ["minimum", "maximum"].forEach((key) => supported.add(key));
  if (kind === "array") {
    ["minItems", "maxItems", "uniqueItems"].forEach((key) => supported.add(key));
    if (isRecord(schema.items)) supported.add("items");
  }
  if (kind === "object") {
    if (isRecord(schema.properties)) supported.add("properties");
    if (Array.isArray(schema.required) && schema.required.every((value) => typeof value === "string")) supported.add("required");
    if (typeof schema.additionalProperties === "boolean") supported.add("additionalProperties");
  }
  return Object.keys(schema).filter((key) => !supported.has(key));
}

function fieldConstraints(schema: Record<string, unknown>): TypeFieldConstraints {
  return {
    ...("const" in schema ? { constant: schema.const } : {}),
    ...(Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string") ? { choices: schema.enum as string[] } : {}),
    ...("default" in schema ? { defaultValue: schema.default } : {}),
    ...(typeof schema.minLength === "number" ? { minLength: schema.minLength } : {}),
    ...(typeof schema.maxLength === "number" ? { maxLength: schema.maxLength } : {}),
    ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {}),
    ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
    ...(typeof schema.minItems === "number" ? { minItems: schema.minItems } : {}),
    ...(typeof schema.maxItems === "number" ? { maxItems: schema.maxItems } : {}),
    ...(typeof schema.uniqueItems === "boolean" ? { uniqueItems: schema.uniqueItems } : {}),
    ...(typeof schema.additionalProperties === "boolean" ? { additionalProperties: schema.additionalProperties } : {})
  };
}

function parseTypeSource(source: string): ParsedTypeSource {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);
  if (!match) throw new Error("Type definitions need YAML frontmatter between --- markers.");
  const document = parseDocument(match[1]);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const value = document.toJS();
  if (!isRecord(value)) throw new Error("The type definition must be a YAML object.");
  if (value.kind !== "mdbase.type") throw new Error("Type definitions must declare kind: mdbase.type.");
  return { document, tail: match[2], value };
}

function mutate(source: string, change: (document: Document) => void): string {
  const parsed = parseTypeSource(source);
  change(parsed.document);
  return `---\n${parsed.document.toString({ lineWidth: 0 })}---${parsed.tail}`;
}

function replaceSchemaKind(document: Document, path: TypeSchemaPath, kind: Exclude<TypeFieldKind, "advanced">) {
  for (const key of KIND_KEYS) document.deleteIn([...SCHEMA_ROOT, ...path, key]);
  const definition = kindDefinition(kind);
  for (const [key, value] of Object.entries(definition)) document.setIn([...SCHEMA_ROOT, ...path, key], value);
}

function requiredFields(document: Document, objectPath: TypeSchemaPath): string[] {
  const required = document.getIn([...SCHEMA_ROOT, ...objectPath, "required"]);
  if (isSeq(required)) {
    return required.items.flatMap((item) => isScalar(item) && typeof item.value === "string" ? [item.value] : []);
  }
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function setRequiredFields(document: Document, objectPath: TypeSchemaPath, fields: string[]) {
  if (fields.length) document.setIn([...SCHEMA_ROOT, ...objectPath, "required"], fields);
  else document.deleteIn([...SCHEMA_ROOT, ...objectPath, "required"]);
}

function fieldKind(definition: Record<string, unknown>): TypeFieldKind {
  if (definition.type === "string" && definition.format === "date") return "date";
  if (definition.type === "string" && definition.format === "date-time") return "datetime";
  if (definition.type === "array") return "array";
  if (["string", "number", "integer", "boolean", "object"].includes(String(definition.type))) return definition.type as TypeFieldKind;
  if (typeof definition.const === "string" || (Array.isArray(definition.enum) && definition.enum.every((item) => typeof item === "string"))) return "string";
  if (typeof definition.const === "number") return Number.isInteger(definition.const) ? "integer" : "number";
  if (typeof definition.const === "boolean") return "boolean";
  return "advanced";
}

function kindDefinition(kind: Exclude<TypeFieldKind, "advanced">): Record<string, unknown> {
  if (kind === "date") return { type: "string", format: "date" };
  if (kind === "datetime") return { type: "string", format: "date-time" };
  if (kind === "array") return { type: "array", items: { type: "string" } };
  if (kind === "object") return { type: "object", additionalProperties: true, properties: {} };
  return { type: kind };
}

function fieldPath(pathOrName: TypeSchemaPath | string): TypeSchemaPath {
  return typeof pathOrName === "string" ? ["properties", pathOrName] : pathOrName;
}

function objectParentPath(fieldSchemaPath: TypeSchemaPath): TypeSchemaPath {
  if (fieldSchemaPath.at(-2) !== "properties") throw new Error("The schema path does not identify an object field.");
  return fieldSchemaPath.slice(0, -2);
}

function schemaValuePath(schemaPath: TypeSchemaPath): string[] {
  return schemaPath.flatMap((segment, index) =>
    schemaPath[index - 1] === "properties" ? [segment] : []);
}

function renameContractFieldReferences(document: Document, from: string[], to: string[]) {
  const implementations = array(record(document.toJS()).implements);
  implementations.forEach((candidate, implementationIndex) => {
    const fields = record(record(candidate).fields);
    Object.entries(fields).forEach(([contractReference, typeReference]) => {
      if (typeof typeReference !== "string") return;
      const renamed = renameTypeReference(typeReference, from, to);
      if (renamed !== typeReference) {
        document.setIn(["implements", implementationIndex, "fields", contractReference], renamed);
      }
    });
  });
}

function renameTypeReference(reference: string, from: string[], to: string[]): string {
  const pointer = reference.startsWith("/");
  const segments = pointer
    ? reference.slice(1).split("/").filter(Boolean)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    : reference.split(".").filter(Boolean);
  if (segments.length < from.length || !from.every((segment, index) => segments[index] === segment)) {
    return reference;
  }
  const renamed = [...to, ...segments.slice(from.length)];
  return pointer
    ? `/${renamed.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
    : renamed.join(".");
}

function schemaAtPath(source: string, path: TypeSchemaPath): Record<string, unknown> {
  const { value } = parseTypeSource(source);
  let current: unknown = record(record(value.schema).value);
  for (const segment of path) current = record(current)[segment];
  return record(current);
}

function findSchemaNode(fields: TypeFieldDefinition[], path: TypeSchemaPath): TypeSchemaNode | undefined {
  for (const field of fields) {
    if (samePath(field.path, path)) return field;
    const nested = findSchemaNode(field.fields, path);
    if (nested) return nested;
    if (field.item) {
      if (samePath(field.item.path, path)) return field.item;
      const itemNested = findSchemaNode(field.item.fields, path);
      if (itemNested) return itemNested;
      const deepItem = findInItem(field.item.item, path);
      if (deepItem) return deepItem;
    }
  }
  return undefined;
}

function findInItem(item: TypeSchemaNode | undefined, path: TypeSchemaPath): TypeSchemaNode | undefined {
  if (!item) return undefined;
  if (samePath(item.path, path)) return item;
  const nested = findSchemaNode(item.fields, path);
  return nested ?? findInItem(item.item, path);
}

function flattenFields(fields: TypeFieldDefinition[]): Map<string, TypeFieldDefinition> {
  const result = new Map<string, TypeFieldDefinition>();
  const visit = (field: TypeFieldDefinition) => {
    result.set(typeFieldPathLabel(field.path), field);
    field.fields.forEach(visit);
    visitItemFields(field.item);
  };
  const visitItemFields = (item?: TypeSchemaNode) => {
    if (!item) return;
    item.fields.forEach(visit);
    visitItemFields(item.item);
  };
  fields.forEach(visit);
  return result;
}

function fieldSignature(field: TypeFieldDefinition): string {
  const { properties: _properties, required: _required, items: _items, ...shallow } = field.raw;
  return JSON.stringify(shallow);
}

function definitionChanges(previousSource: string | undefined, nextSource: string): string[] {
  if (!previousSource) return ["New type definition"];
  const previous = parseTypeSource(previousSource);
  const next = parseTypeSource(nextSource);
  const changes: string[] = [];
  if (previous.value.name !== next.value.name) changes.push("Type name");
  if (previous.value.description !== next.value.description) changes.push("Description");
  if (JSON.stringify(previous.value.match) !== JSON.stringify(next.value.match)) changes.push("Matching rules");
  if (JSON.stringify(previous.value.implements) !== JSON.stringify(next.value.implements)) changes.push("Application compatibility");
  if (JSON.stringify(previous.value.collection) !== JSON.stringify(next.value.collection)) changes.push("Collection behaviour");
  if (JSON.stringify(previous.value.lifecycle) !== JSON.stringify(next.value.lifecycle)) changes.push("Lifecycle");
  if (JSON.stringify(schemaEnvelope(previous.value)) !== JSON.stringify(schemaEnvelope(next.value))) changes.push("Schema settings");
  if (previous.tail !== next.tail) changes.push("Documentation");
  return changes;
}

function typeCollectionChanges(previousSource: string | undefined, nextSource: string): string[] {
  const previous = previousSource ? record(parseTypeSource(previousSource).value.collection) : {};
  const next = record(parseTypeSource(nextSource).value.collection);
  const sections: Array<[string, string]> = [
    ["display", "Display metadata"],
    ["read_defaults", "Read defaults"],
    ["links", "Link rules"],
    ["unique", "Uniqueness rules"],
    ["path", "Path policy"],
    ["projections", "Projections"]
  ];
  const changes = sections
    .filter(([key]) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .map(([, label]) => label);
  const known = new Set(sections.map(([key]) => key));
  const previousOther = Object.fromEntries(Object.entries(previous).filter(([key]) => !known.has(key)));
  const nextOther = Object.fromEntries(Object.entries(next).filter(([key]) => !known.has(key)));
  if (JSON.stringify(previousOther) !== JSON.stringify(nextOther)) changes.push("Other collection rules");
  return changes;
}

function schemaEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  const schema = record(value.schema);
  const embedded = record(schema.value);
  const { properties: _properties, required: _required, ...root } = embedded;
  return { ...schema, ...(schema.value ? { value: root } : {}) };
}

function missingRequiredValue(frontmatter: Record<string, unknown>, valuePath: TypeValuePath): boolean {
  const name = valuePath.at(-1);
  if (typeof name !== "string" || name === "[]") return false;
  const containers = containersAt(frontmatter, valuePath.slice(0, -1));
  return containers.some((container) => isRecord(container) && !hasValue(container[name]));
}

function containersAt(value: unknown, path: TypeValuePath): unknown[] {
  let values: unknown[] = [value];
  for (const segment of path) {
    if (segment === "[]") {
      values = values.flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
    } else {
      values = values.flatMap((candidate) => isRecord(candidate) && segment in candidate ? [candidate[segment]] : []);
    }
  }
  return values;
}

function noteMatchesVisualType(note: NoteSummary, definition: VisualTypeDefinition, explicitTypeKeys: string[]): boolean {
  const hasExplicitDeclaration = explicitTypeKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(note.frontmatter, key));
  if (hasExplicitDeclaration) {
    return explicitTypeNames(note, explicitTypeKeys).some((name) => sameTypeName(name, definition.name));
  }
  const hasAutomaticRules = definition.pathGlobs.length > 0 || definition.fieldsPresent.length > 0;
  if (!hasAutomaticRules) return false;
  if (definition.pathGlobs.length > 0
    && !definition.pathGlobs.some((pattern) => matchesPathGlob(note.path, pattern))) return false;
  return definition.fieldsPresent.every((reference) => fieldReferenceValue(note.frontmatter, reference) != null);
}

function explicitTypeNames(note: NoteSummary, explicitTypeKeys: string[]): string[] {
  const values = explicitTypeKeys.map((key) => note.frontmatter[key]);
  return values.flatMap((value) => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}

function sameTypeName(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function matchesPathGlob(pathValue: string, patternValue: string): boolean {
  const path = pathValue.replaceAll("\\", "/").split("/");
  const pattern = patternValue.replaceAll("\\", "/").split("/");
  const memo = new Map<string, boolean>();
  const matchParts = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched: boolean;
    if (patternIndex === pattern.length) matched = pathIndex === path.length;
    else if (pathIndex === path.length) matched = pattern.slice(patternIndex).every((part) => part === "**");
    else if (pattern[patternIndex] === "**") {
      matched = matchParts(pathIndex, patternIndex + 1) || matchParts(pathIndex + 1, patternIndex);
    } else {
      matched = segmentMatches(path[pathIndex], pattern[patternIndex])
        && matchParts(pathIndex + 1, patternIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return matchParts(0, 0);
}

function segmentMatches(segmentValue: string, patternValue: string): boolean {
  const segment = [...segmentValue];
  const pattern = [...patternValue];
  const memo = new Map<string, boolean>();
  const matchCharacters = (segmentIndex: number, patternIndex: number): boolean => {
    const key = `${segmentIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched: boolean;
    if (patternIndex === pattern.length) matched = segmentIndex === segment.length;
    else if (segmentIndex === segment.length) matched = pattern.slice(patternIndex).every((character) => character === "*");
    else if (pattern[patternIndex] === "*") {
      matched = matchCharacters(segmentIndex, patternIndex + 1)
        || matchCharacters(segmentIndex + 1, patternIndex);
    } else if (pattern[patternIndex] === "?") {
      matched = matchCharacters(segmentIndex + 1, patternIndex + 1);
    } else {
      matched = segment[segmentIndex] === pattern[patternIndex]
        && matchCharacters(segmentIndex + 1, patternIndex + 1);
    }
    memo.set(key, matched);
    return matched;
  };
  return matchCharacters(0, 0);
}

function fieldReferenceValue(source: Record<string, unknown>, reference: string): unknown {
  const pointer = reference.startsWith("/");
  const fieldPath = /^[A-Za-z_][A-Za-z0-9_:-]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_:-]*(?:\[\])?)*$/;
  const jsonPointer = /^(?:\/(?:[^~/]|~[01])*)+$/;
  if (!fieldPath.test(reference) && !jsonPointer.test(reference)) return undefined;
  const segments = pointer
    ? reference.slice(1).split("/").map((token) => ({ key: token.replaceAll("~1", "/").replaceAll("~0", "~"), each: false }))
    : reference.split(".").map((token) => ({
      key: token.endsWith("[]") ? token.slice(0, -2) : token,
      each: token.endsWith("[]")
    }));
  let current: unknown[] = [source];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      let selected: unknown;
      if (isRecord(value)) selected = value[segment.key];
      else if (pointer && Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(segment.key)) selected = value[Number(segment.key)];
      if (selected === undefined) continue;
      if (segment.each) {
        if (Array.isArray(selected)) next.push(...selected);
      } else {
        next.push(selected);
      }
    }
    current = next;
    if (!current.length) break;
  }
  return current[0];
}

function constraintLabel(key: string): string {
  const labels: Record<string, string> = {
    const: "constant value",
    enum: "choices",
    format: "format",
    items: "list item schema",
    properties: "nested fields",
    required: "nested required fields",
    additionalProperties: "additional field policy",
    minLength: "minimum length",
    maxLength: "maximum length",
    pattern: "pattern",
    minimum: "minimum",
    maximum: "maximum",
    minItems: "minimum items",
    maxItems: "maximum items",
    uniqueItems: "unique items",
    default: "default",
    examples: "examples"
  };
  return labels[key] ?? key;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizedStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function renameCollectionMapEntry(source: string, parentPath: string[], from: string, to: string, label: string): string {
  const name = to.trim();
  if (!name || name === from) return source;
  return mutate(source, (document) => {
    if (document.getIn([...parentPath, name]) !== undefined) {
      throw new Error(`A ${label} for “${name}” already exists.`);
    }
    const value = document.getIn([...parentPath, from]);
    document.setIn([...parentPath, name], value);
    document.deleteIn([...parentPath, from]);
  });
}

function deleteInAndPrune(document: Document, path: Array<string | number>) {
  document.deleteIn(path);
  for (let length = path.length - 1; length >= 1; length -= 1) {
    const parentPath = path.slice(0, length);
    const parent = document.getIn(parentPath);
    if ((isMap(parent) || isSeq(parent)) && parent.items.length === 0) document.deleteIn(parentPath);
    else break;
  }
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function samePath(left: TypeSchemaPath, right: TypeSchemaPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
