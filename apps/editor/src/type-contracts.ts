import type { CollectionContractDescriptor, JsonObject } from "@mdbase-dev/connect";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import type { TypeFieldKind } from "./type-schema";

export interface TypeContractImplementation {
  contract: string;
  version: string;
  fields: Record<string, string>;
  binding?: JsonObject;
  sourceIndex: number;
}

export interface ContractField {
  name: string;
  reference: string;
  required: boolean;
  kind: TypeFieldKind;
  description?: string;
  schema: JsonObject;
}

export interface ContractTypeField {
  label: string;
  reference: string;
  kind: TypeFieldKind;
  required: boolean;
  description?: string;
  schema: JsonObject;
}

export interface ContractMappingAssessment {
  level: "valid" | "warning" | "error" | "unmapped";
  label: string;
  message: string;
}

export interface ContractValidationIssue {
  level: "error" | "warning";
  message: string;
  implementationIndex?: number;
  contract?: string;
  field?: string;
}

export interface ContractSuggestion {
  contract: CollectionContractDescriptor;
  matchedFields: number;
  totalFields: number;
  requiredMatched: number;
  requiredFields: number;
}

interface ParsedTypeSource {
  document: Document;
  tail: string;
  value: Record<string, unknown>;
}

export function contractKey(contract: Pick<CollectionContractDescriptor, "id" | "version">): string {
  return `${contract.id}@${contract.version}`;
}

export function contractFields(contract: CollectionContractDescriptor): ContractField[] {
  const properties = schemaProperties(contract.schema, contract.schema);
  const required = new Set(schemaRequiredFields(contract.schema, contract.schema));
  return Object.entries(properties).map(([name, schema]) => {
    const resolved = resolvedSchema(contract.schema, record(schema));
    return {
      name,
      reference: fieldReference(name),
      required: required.has(name),
      kind: schemaKind(resolved),
      ...(typeof resolved.description === "string" ? { description: resolved.description } : {}),
      schema: resolved as JsonObject
    };
  });
}

export function typeFieldsForContracts(
  source: string,
  resolvedTypeSchema?: JsonObject
): ContractTypeField[] {
  const parsed = parseTypeSource(source);
  const inlineSchema = record(record(parsed.value.schema).value);
  const schema = Object.keys(inlineSchema).length ? inlineSchema : record(resolvedTypeSchema);
  return schemaFieldsForContracts(schema);
}

export function typeSchemaReference(source: string): string | undefined {
  const { value } = parseTypeSource(source);
  const reference = record(value.schema).ref;
  return typeof reference === "string" && reference.trim() ? reference : undefined;
}

export function readTypeContractImplementations(source: string): TypeContractImplementation[] {
  const { value } = parseTypeSource(source);
  return array(value.implements).flatMap((candidate, sourceIndex) => {
    const implementation = record(candidate);
    if (typeof implementation.contract !== "string" || typeof implementation.version !== "string") return [];
    const binding = record(implementation.binding);
    return [{
      contract: implementation.contract,
      version: implementation.version,
      fields: stringRecord(implementation.fields),
      ...(Object.keys(binding).length ? { binding: binding as JsonObject } : {}),
      sourceIndex
    }];
  });
}

export function createTypeSourceFromContract(
  source: string,
  contract: CollectionContractDescriptor,
  existingTypeNames: string[] = []
): string {
  return mutate(source, (document) => {
    const name = availableTypeName(contract.id, existingTypeNames);
    const fields = contractFields(contract);
    const schema = fields.length ? {
      ...(typeof contract.schema.$schema === "string" ? { $schema: contract.schema.$schema } : {}),
      ...(isRecord(contract.schema.$defs) ? { $defs: structuredClone(contract.schema.$defs) } : {}),
      type: "object",
      additionalProperties: true,
      properties: Object.fromEntries(fields.map((field) => [field.name, structuredClone(field.schema)])),
      ...(fields.some((field) => field.required)
        ? { required: fields.filter((field) => field.required).map((field) => field.name) }
        : {})
    } : {
      ...structuredClone(contract.schema),
      additionalProperties: true
    };
    delete (schema as Record<string, unknown>).$id;
    document.setIn(["name"], name);
    document.setIn(["version"], 1);
    document.setIn(["description"], `Implements ${contract.id} ${contract.version}.`);
    document.setIn(["schema"], {
      dialect: "json-schema-2020-12",
      value: schema
    });
    document.setIn(["implements"], [implementationValue(contract, Object.fromEntries(
      contractFields(contract).map((field) => [field.reference, field.reference])
    ))]);
  });
}

export function addTypeContractImplementation(
  source: string,
  contract: CollectionContractDescriptor,
  resolvedTypeSchema?: JsonObject
): string {
  const implementations = readTypeContractImplementations(source);
  if (implementations.some((implementation) =>
    implementation.contract === contract.id && implementation.version === contract.version)) {
    throw new Error(`${contract.id} ${contract.version} is already implemented.`);
  }
  const mappings = suggestedFieldMappings(source, contract, resolvedTypeSchema);
  return mutate(source, (document) => {
    const current = document.getIn(["implements"]);
    if (Array.isArray(current) || isSeq(current)) {
      document.addIn(["implements"], implementationValue(contract, mappings));
    } else {
      document.setIn(["implements"], [implementationValue(contract, mappings)]);
    }
  });
}

export function removeTypeContractImplementation(
  source: string,
  contractId: string,
  version: string
): string {
  const implementation = readTypeContractImplementations(source).find((candidate) =>
    candidate.contract === contractId && candidate.version === version);
  if (!implementation) return source;
  return mutate(source, (document) => {
    document.deleteIn(["implements", implementation.sourceIndex]);
    const remaining = document.getIn(["implements"]);
    if ((Array.isArray(remaining) && remaining.length === 0)
      || (isSeq(remaining) && remaining.items.length === 0)) {
      document.deleteIn(["implements"]);
    }
  });
}

export function setTypeContractFieldMapping(
  source: string,
  contractId: string,
  version: string,
  contractField: string,
  typeField?: string
): string {
  const implementation = readTypeContractImplementations(source).find((candidate) =>
    candidate.contract === contractId && candidate.version === version);
  if (!implementation) throw new Error(`${contractId} ${version} is not implemented by this type.`);
  return mutate(source, (document) => {
    const fieldsPath = ["implements", implementation.sourceIndex, "fields"] as Array<string | number>;
    const aliases = equivalentReferences(contractField);
    aliases.forEach((alias) => document.deleteIn([...fieldsPath, alias]));
    if (typeField) {
      document.setIn([...fieldsPath, contractField], typeField);
      return;
    }
    document.deleteIn([...fieldsPath, contractField]);
    const fields = document.getIn(fieldsPath);
    if (!fields || isEmptyYamlMap(fields)) document.setIn(fieldsPath, {});
  });
}

export function setTypeContractBinding(
  source: string,
  contractId: string,
  version: string,
  binding: JsonObject
): string {
  const implementation = readTypeContractImplementations(source).find((candidate) =>
    candidate.contract === contractId && candidate.version === version);
  if (!implementation) throw new Error(`${contractId} ${version} is not implemented by this type.`);
  return mutate(source, (document) => {
    const bindingPath = ["implements", implementation.sourceIndex, "binding"] as Array<string | number>;
    if (Object.keys(binding).length) document.setIn(bindingPath, structuredClone(binding));
    else document.deleteIn(bindingPath);
  });
}

export function contractViewPreview(
  implementation: Pick<TypeContractImplementation, "fields">
): JsonObject {
  const preview: JsonObject = {};
  for (const [contractReference, typeReference] of Object.entries(implementation.fields)) {
    setPreviewValue(preview, referenceSegments(contractReference), `← ${typeReference}`);
  }
  return preview;
}

export function validateTypeContractImplementations(
  source: string,
  contracts: CollectionContractDescriptor[],
  resolvedTypeSchema?: JsonObject
): ContractValidationIssue[] {
  const parsed = parseTypeSource(source);
  const rawImplementations = array(parsed.value.implements);
  const inlineTypeSchema = record(record(parsed.value.schema).value);
  const typeSchema = Object.keys(inlineTypeSchema).length
    ? inlineTypeSchema
    : record(resolvedTypeSchema);
  const typeFields = typeFieldsForContracts(source, resolvedTypeSchema);
  const typeFieldsByReference = new Map(typeFields.map((field) => [field.reference, field]));
  const contractsByKey = new Map(contracts.map((contract) => [contractKey(contract), contract]));
  const seen = new Set<string>();
  const issues: ContractValidationIssue[] = [];

  rawImplementations.forEach((candidate, implementationIndex) => {
    const implementation = record(candidate);
    const contractId = typeof implementation.contract === "string" ? implementation.contract : undefined;
    const version = typeof implementation.version === "string" ? implementation.version : undefined;
    if (!contractId || !version) {
      issues.push({
        level: "error",
        implementationIndex,
        message: "Each implementation needs an exact contract ID and version."
      });
      return;
    }
    const key = `${contractId}@${version}`;
    if (seen.has(key)) {
      issues.push({
        level: "error",
        implementationIndex,
        contract: contractId,
        message: `${contractId} ${version} is implemented more than once.`
      });
    }
    seen.add(key);
    const contract = contractsByKey.get(key);
    if (!contract) {
      issues.push({
        level: "error",
        implementationIndex,
        contract: contractId,
        message: `${contractId} ${version} is not installed in this collection.`
      });
      return;
    }

    const fields = stringRecord(implementation.fields);
    if (!isRecord(implementation.fields)) {
      issues.push({
        level: "error",
        implementationIndex,
        contract: contractId,
        message: "Field mappings must be a YAML object."
      });
    }

    for (const field of contractFields(contract).filter((field) => field.required)) {
      if (!mappingForField(fields, field)) {
        issues.push({
          level: "error",
          implementationIndex,
          contract: contractId,
          field: field.reference,
          message: `Map required contract field ${field.reference}.`
        });
      }
    }

    for (const [contractReference, typeReference] of Object.entries(fields)) {
      const contractFieldSchema = schemaAtReference(contract.schema, contractReference);
      if (!contractFieldSchema) {
        issues.push({
          level: "error",
          implementationIndex,
          contract: contractId,
          field: contractReference,
          message: `${contractReference} is not declared by ${contractId}.`
        });
        continue;
      }
      const typeFieldSchema = schemaAtReference(typeSchema, typeReference);
      if (!typeFieldSchema) {
        issues.push({
          level: "error",
          implementationIndex,
          contract: contractId,
          field: contractReference,
          message: `${typeReference} is not declared by the type schema.`
        });
        continue;
      }
      const contractField = contractFields(contract).find((field) =>
        equivalentReferences(field.reference).includes(contractReference));
      const typeField = typeFieldsByReference.get(typeReference)
        ?? typeFields.find((field) => equivalentReferences(field.reference).includes(typeReference));
      const assessment = contractField && typeField
        ? assessContractFieldMapping(contractField, typeField)
        : assessSchemaCompatibility(contractFieldSchema, typeFieldSchema, false, true);
      if (assessment.level === "error" || assessment.level === "warning") {
        issues.push({
          level: assessment.level,
          implementationIndex,
          contract: contractId,
          field: contractReference,
          message: assessment.message
        });
      }
    }

    const binding = record(implementation.binding);
    if (contract.bindingSchema) {
      const bindingIssue = validateBinding(contract.bindingSchema, binding, contractId);
      if (bindingIssue) {
        issues.push({
          level: "error",
          implementationIndex,
          contract: contractId,
          message: bindingIssue
        });
      }
    } else if (Object.keys(binding).length) {
      issues.push({
        level: "error",
        implementationIndex,
        contract: contractId,
        message: `${contractId} does not define implementation bindings.`
      });
    }
  });

  return issues;
}

export function suggestContractsForType(
  source: string,
  contracts: CollectionContractDescriptor[],
  resolvedTypeSchema?: JsonObject
): ContractSuggestion[] {
  const implementations = new Set(readTypeContractImplementations(source)
    .map((implementation) => `${implementation.contract}@${implementation.version}`));
  const typeFields = typeFieldsForContracts(source, resolvedTypeSchema);
  return contracts.flatMap((contract) => {
    if (implementations.has(contractKey(contract))) return [];
    const fields = contractFields(contract);
    if (!fields.length) return [];
    const matches = fields.filter((field) => matchingTypeField(typeFields, field));
    const required = fields.filter((field) => field.required);
    const requiredMatched = required.filter((field) => matchingTypeField(typeFields, field)).length;
    const weightedTotal = fields.length + required.length;
    const weightedMatches = matches.length + requiredMatched;
    if (!matches.length || weightedMatches / weightedTotal < 0.45) return [];
    return [{
      contract,
      matchedFields: matches.length,
      totalFields: fields.length,
      requiredMatched,
      requiredFields: required.length
    }];
  }).sort((left, right) => {
    const leftScore = (left.matchedFields + left.requiredMatched) / (left.totalFields + left.requiredFields);
    const rightScore = (right.matchedFields + right.requiredMatched) / (right.totalFields + right.requiredFields);
    return rightScore - leftScore || contractKey(left.contract).localeCompare(contractKey(right.contract));
  });
}

export function mappingForContractField(
  implementation: TypeContractImplementation,
  field: ContractField
): string {
  return mappingForField(implementation.fields, field) ?? "";
}

export function assessContractFieldMapping(
  field: ContractField,
  typeField?: ContractTypeField
): ContractMappingAssessment {
  if (!typeField) {
    return field.required
      ? {
          level: "error",
          label: "Required",
          message: `Map required contract field ${field.reference}.`
        }
      : {
          level: "unmapped",
          label: "Not exposed",
          message: "This optional contract field is not exposed."
        };
  }
  return assessSchemaCompatibility(
    field.schema,
    typeField.schema,
    field.required,
    typeField.required,
    field.reference,
    typeField.label
  );
}

function implementationValue(
  contract: CollectionContractDescriptor,
  fields: Record<string, string>
): Record<string, unknown> {
  return {
    contract: contract.id,
    version: contract.version,
    fields
  };
}

function suggestedFieldMappings(
  source: string,
  contract: CollectionContractDescriptor,
  resolvedTypeSchema?: JsonObject
): Record<string, string> {
  const typeFields = typeFieldsForContracts(source, resolvedTypeSchema);
  return Object.fromEntries(contractFields(contract).flatMap((field) => {
    const match = matchingTypeField(typeFields, field);
    return match ? [[field.reference, match.reference]] : [];
  }));
}

function assessSchemaCompatibility(
  contractSchemaValue: Record<string, unknown>,
  typeSchemaValue: Record<string, unknown>,
  contractRequired: boolean,
  typeRequired: boolean,
  contractReference = "The contract field",
  typeReference = "the type field"
): ContractMappingAssessment {
  const contractKind = schemaKind(contractSchemaValue);
  const typeKind = schemaKind(typeSchemaValue);
  if (!compatibleKinds(contractKind, typeKind)) {
    return {
      level: "error",
      label: "Incompatible",
      message: `${contractReference} expects ${kindLabel(contractKind)}, but ${typeReference} is ${kindLabel(typeKind)}.`
    };
  }

  const warnings: string[] = [];
  if (contractRequired && !typeRequired) {
    warnings.push(`${typeReference} is optional, so some records may omit this required value.`);
  }
  if (contractKind === "advanced" || typeKind === "advanced") {
    warnings.push("A complex schema needs record-level validation.");
  }

  const contractValues = schemaAllowedValues(contractSchemaValue);
  const typeValues = schemaAllowedValues(typeSchemaValue);
  if (contractValues) {
    if (!typeValues) {
      warnings.push(`${typeReference} allows values outside the contract’s accepted set.`);
    } else {
      const accepted = [...typeValues].filter((value) => contractValues.has(value));
      if (!accepted.length) {
        return {
          level: "error",
          label: "Incompatible",
          message: `${typeReference} cannot produce a value accepted by ${contractReference}.`
        };
      }
      if (accepted.length < typeValues.size) {
        warnings.push(`${typeReference} allows values the contract rejects.`);
      }
    }
  }

  const range = rangeCompatibility(contractSchemaValue, typeSchemaValue, contractKind);
  if (range === "disjoint") {
    return {
      level: "error",
      label: "Incompatible",
      message: `${typeReference} and ${contractReference} allow non-overlapping values.`
    };
  }
  if (range === "broader") {
    warnings.push(`${typeReference} permits values outside the contract’s limits.`);
  }

  const contractFormat = typeof contractSchemaValue.format === "string"
    ? contractSchemaValue.format
    : undefined;
  const typeFormat = typeof typeSchemaValue.format === "string"
    ? typeSchemaValue.format
    : undefined;
  if (contractFormat && contractFormat !== typeFormat) {
    warnings.push(`${typeReference} does not guarantee the contract’s ${contractFormat} format.`);
  }
  if (typeof contractSchemaValue.pattern === "string"
      && contractSchemaValue.pattern !== typeSchemaValue.pattern) {
    warnings.push(`${typeReference} does not guarantee the contract’s text pattern.`);
  }
  if (contractKind === "object"
      && contractSchemaValue.additionalProperties === false
      && typeSchemaValue.additionalProperties !== false) {
    warnings.push(`${typeReference} may contain properties rejected by the contract.`);
  }
  if (contractKind === "array") {
    const contractItem = record(contractSchemaValue.items);
    const typeItem = record(typeSchemaValue.items);
    if (Object.keys(contractItem).length && Object.keys(typeItem).length
        && !compatibleKinds(schemaKind(contractItem), schemaKind(typeItem))) {
      return {
        level: "error",
        label: "Incompatible",
        message: `${typeReference} contains ${kindLabel(schemaKind(typeItem))} values, but ${contractReference} expects ${kindLabel(schemaKind(contractItem))} values.`
      };
    }
  }

  return warnings.length
    ? {
        level: "warning",
        label: "Review",
        message: warnings.join(" ")
      }
    : {
        level: "valid",
        label: "Compatible",
        message: `${typeReference} satisfies the declared contract field constraints.`
      };
}

function matchingTypeField(
  typeFields: ContractTypeField[],
  contractField: ContractField
): ContractTypeField | undefined {
  const exact = typeFields.find((field) =>
    field.reference.toLocaleLowerCase() === contractField.reference.toLocaleLowerCase()
    && compatibleKinds(contractField.kind, field.kind));
  if (exact) return exact;
  const named = typeFields.filter((field) =>
    lastReferenceSegment(field.reference).toLocaleLowerCase() === contractField.name.toLocaleLowerCase()
    && compatibleKinds(contractField.kind, field.kind));
  return named.length === 1 ? named[0] : undefined;
}

function mappingForField(fields: Record<string, string>, field: ContractField): string | undefined {
  return fields[field.reference] ?? fields[field.name] ?? fields[jsonPointer([field.name])];
}

function schemaFieldsForContracts(schema: Record<string, unknown>): ContractTypeField[] {
  const result: ContractTypeField[] = [];
  const visit = (
    current: Record<string, unknown>,
    path: string[],
    parentRequired: boolean,
    depth: number
  ) => {
    if (depth > 12) return;
    const properties = schemaProperties(schema, current);
    const required = new Set(schemaRequiredFields(schema, current));
    for (const [name, candidate] of Object.entries(properties)) {
      const fieldPath = [...path, name];
      const fieldSchema = resolvedSchema(schema, record(candidate));
      const reference = referenceForSegments(fieldPath);
      const fieldRequired = parentRequired && required.has(name);
      result.push({
        label: fieldPath.join("."),
        reference,
        kind: schemaKind(fieldSchema),
        required: fieldRequired,
        ...(typeof fieldSchema.description === "string"
          ? { description: fieldSchema.description }
          : {}),
        schema: fieldSchema as JsonObject
      });
      if (schemaKind(fieldSchema) === "object") {
        visit(fieldSchema, fieldPath, fieldRequired, depth + 1);
      }
    }
  };
  visit(schema, [], true, 0);
  return uniqueBy(result, (field) => field.reference);
}

function schemaAtReference(schema: unknown, reference: string): Record<string, unknown> | undefined {
  const root = record(schema);
  let current: unknown = root;
  for (const segment of referenceSegments(reference)) {
    current = schemaProperty(root, record(current), segment, new Set());
    if (current === undefined) return undefined;
  }
  return isRecord(current) ? current : undefined;
}

function schemaAllowedValues(schema: Record<string, unknown>): Set<string> | undefined {
  if ("const" in schema) return new Set([stableValue(schema.const)]);
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return new Set(schema.enum.map(stableValue));
  }
  return undefined;
}

const bindingValidators = new WeakMap<JsonObject, ValidateFunction>();

function validateBinding(schema: JsonObject, binding: Record<string, unknown>, contractId: string): string | undefined {
  let validate = bindingValidators.get(schema);
  try {
    if (!validate) {
      validate = new Ajv2020({
        allErrors: true,
        strict: false,
        validateFormats: false
      }).compile(schema);
      bindingValidators.set(schema, validate);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid JSON Schema";
    return `Binding settings for ${contractId} cannot be edited because its schema is invalid: ${detail}`;
  }
  if (validate(binding)) return undefined;
  const errors = validate.errors ?? [];
  const first = errors[0];
  if (!first) return `Binding settings do not satisfy ${contractId}.`;
  const message = bindingErrorMessage(first, contractId);
  return errors.length > 1 ? `${message} ${errors.length - 1} more ${errors.length === 2 ? "setting needs" : "settings need"} attention.` : message;
}

function bindingErrorMessage(error: ErrorObject, contractId: string): string {
  const segments = error.instancePath.slice(1).split("/").filter(Boolean)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    segments.push(error.params.missingProperty);
    return `Binding setting ${segments.join(".")} is required by ${contractId}.`;
  }
  const field = segments.length ? ` ${segments.join(".")}` : "";
  if (error.keyword === "minLength" && error.params.limit === 1) {
    return `Binding setting${field} must not be empty for ${contractId}.`;
  }
  if (error.keyword === "minItems" && typeof error.params.limit === "number") {
    return `Binding setting${field} needs at least ${error.params.limit} ${error.params.limit === 1 ? "item" : "items"} for ${contractId}.`;
  }
  return `Binding setting${field} ${error.message ?? "is invalid"} for ${contractId}.`;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function rangeCompatibility(
  contract: Record<string, unknown>,
  type: Record<string, unknown>,
  kind: TypeFieldKind
): "compatible" | "broader" | "disjoint" {
  const keys = kind === "string"
    ? ["minLength", "maxLength"] as const
    : kind === "array"
      ? ["minItems", "maxItems"] as const
      : ["minimum", "maximum"] as const;
  if (!["string", "array", "number", "integer"].includes(kind)) return "compatible";
  const contractMin = finiteNumber(contract[keys[0]], Number.NEGATIVE_INFINITY);
  const contractMax = finiteNumber(contract[keys[1]], Number.POSITIVE_INFINITY);
  const typeMin = finiteNumber(type[keys[0]], Number.NEGATIVE_INFINITY);
  const typeMax = finiteNumber(type[keys[1]], Number.POSITIVE_INFINITY);
  if (typeMax < contractMin || typeMin > contractMax) return "disjoint";
  if (typeMin < contractMin || typeMax > contractMax) return "broader";
  return "compatible";
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
    ...schemaAllOfBranches(resolved).flatMap((branch) => schemaRequiredFields(root, branch, seen))
  ])];
}

function schemaProperty(
  root: Record<string, unknown>,
  schema: Record<string, unknown>,
  name: string,
  seen: Set<Record<string, unknown>>
): Record<string, unknown> | undefined {
  let resolved = resolvedSchema(root, schema);
  if (resolved.type === "array" && isRecord(resolved.items)) resolved = resolvedSchema(root, record(resolved.items));
  if (seen.has(resolved)) return undefined;
  seen.add(resolved);
  const direct = record(resolved.properties)[name];
  if (isRecord(direct)) return direct;
  for (const branch of schemaBranches(resolved)) {
    const candidate = schemaProperty(root, branch, name, seen);
    if (candidate) return candidate;
  }
  return undefined;
}

function resolvedSchema(root: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  let current: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/")) {
    current = record(current)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return isRecord(current) ? current : schema;
}

function schemaBranches(schema: Record<string, unknown>): Record<string, unknown>[] {
  return ["allOf", "anyOf", "oneOf"].flatMap((key) =>
    array(schema[key]).filter((value): value is Record<string, unknown> => isRecord(value)));
}

function schemaAllOfBranches(schema: Record<string, unknown>): Record<string, unknown>[] {
  return array(schema.allOf).filter((value): value is Record<string, unknown> => isRecord(value));
}

function referenceSegments(reference: string): string[] {
  if (reference.startsWith("/")) {
    return reference.slice(1).split("/").filter(Boolean)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return reference.split(".").filter(Boolean).map((segment) => segment.replace(/\[\]$/u, ""));
}

function fieldReference(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name) ? name : jsonPointer([name]);
}

function referenceForSegments(segments: string[]): string {
  return segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment))
    ? segments.join(".")
    : jsonPointer(segments);
}

function equivalentReferences(reference: string): string[] {
  const segments = referenceSegments(reference);
  if (!segments.length) return [reference];
  const dot = segments.join(".");
  const pointer = jsonPointer(segments);
  return [...new Set([reference, dot, pointer])];
}

function jsonPointer(segments: string[]): string {
  return `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function lastReferenceSegment(reference: string): string {
  return referenceSegments(reference).at(-1) ?? reference;
}

function setPreviewValue(target: JsonObject, segments: string[], value: string): void {
  if (!segments.length) return;
  let parent = target;
  segments.slice(0, -1).forEach((segment) => {
    const existing = parent[segment];
    if (!isRecord(existing)) parent[segment] = {};
    parent = parent[segment] as JsonObject;
  });
  parent[segments.at(-1)!] = value;
}

function schemaKind(schema: Record<string, unknown>): TypeFieldKind {
  if (schema.type === "string" && schema.format === "date") return "date";
  if (schema.type === "string" && schema.format === "date-time") return "datetime";
  if (["string", "number", "integer", "boolean", "array", "object"].includes(String(schema.type))) {
    return schema.type as TypeFieldKind;
  }
  if (typeof schema.const === "string"
    || (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string"))) {
    return "string";
  }
  if (typeof schema.const === "number") return Number.isInteger(schema.const) ? "integer" : "number";
  if (typeof schema.const === "boolean") return "boolean";
  return "advanced";
}

function compatibleKinds(contractKind: TypeFieldKind, typeKind: TypeFieldKind): boolean {
  if (contractKind === "advanced" || typeKind === "advanced") return true;
  if (contractKind === typeKind) return true;
  if (contractKind === "number" && typeKind === "integer") return true;
  if (contractKind === "string" && (typeKind === "date" || typeKind === "datetime")) return true;
  return false;
}

function kindLabel(kind: TypeFieldKind): string {
  const labels: Record<TypeFieldKind, string> = {
    string: "text",
    number: "a number",
    integer: "an integer",
    boolean: "a checkbox",
    array: "a list",
    object: "an object",
    date: "a date",
    datetime: "a date and time",
    advanced: "an advanced schema"
  };
  return labels[kind];
}

function availableTypeName(contractId: string, existingTypeNames: string[]): string {
  const base = (contractId.split(".").at(-1) ?? "contract")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "contract";
  const existing = new Set(existingTypeNames.map((name) => name.toLocaleLowerCase()));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function parseTypeSource(source: string): ParsedTypeSource {
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/u);
  if (!match) throw new Error("Type definitions need YAML frontmatter between --- markers.");
  const document = parseDocument(match[1]);
  if (document.errors.length) throw new Error(document.errors[0].message);
  const value = document.toJS();
  if (!isRecord(value)) throw new Error("The type definition must be a YAML object.");
  return { document, tail: match[2], value };
}

function mutate(source: string, change: (document: Document) => void): string {
  const parsed = parseTypeSource(source);
  change(parsed.document);
  return `---\n${parsed.document.toString({ lineWidth: 0 })}---${parsed.tail}`;
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
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

function isEmptyYamlMap(value: unknown): boolean {
  return isMap(value) && value.items.length === 0;
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
