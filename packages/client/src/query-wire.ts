import type { CollectionDescription as WireDescription, DataContractViewIdentity as WireIdentity, JsonObject, QueryRecord as WireQueryRecord } from "@mdbase-dev/connect-protocol";
import { authorityCapabilities } from "./authority-features.js";
import { connectError } from "./errors.js";
import type { CollectionDescription, DataContractViewIdentity, QueryInput, QueryMetadataInput, QueryMetadataRecord, QueryMetadataResult, QueryRecord, QueryResult } from "./operation-types.js";

export interface WireQueryResult<Frontmatter extends JsonObject> {
  output?: "metadata";
  results: Array<WireQueryRecord<Frontmatter> | import("@mdbase-dev/connect-protocol").QueryMetadataRecord>;
  meta?: {
    total_count?: number | null;
    total_count_outcome?: { status: "deferred"; budget: "eager_summary_rows"; limit: number };
    has_more: boolean;
    cursor?: string;
    snapshot?: string;
  };
}

// beta.126's typed QueryRequest accepts only string selections. Lower named
// expressions to ordinary projections, which both legacy and current hosts
// accept. Private aliases avoid overwriting user projections or literal fields.
function querySelections(input: QueryInput | QueryMetadataInput) {
  const projections = { ...input.projections };
  const aliases = new Map<string, string>();
  const occupied = new Set([
    ...Object.keys(projections),
    ...(input.select ?? []).filter((s): s is string => typeof s === "string").map(s => s.replace(/^projection\./, ""))
  ]);
  const select = input.select?.map((selection, index) => {
    if (typeof selection === "string") return selection;
    let alias = `connect_select_${index}`;
    while (occupied.has(alias)) alias += "_";
    occupied.add(alias);
    // Selections run after filtering; don't evaluate them on rejected rows.
    projections[alias] = { expression: input.where ? `(${input.where}) ? (${selection.expression}) : null` : selection.expression };
    aliases.set(alias, selection.name);
    return `projection.${alias}`;
  });
  const field = (name: string) => {
    for (const [alias, original] of aliases) if (original === name) return alias;
    return name;
  };
  return { projections, aliases, select, field };
}

export function wireQueryInput(input: QueryInput | QueryMetadataInput) {
  const selection = querySelections(input);
  return {
    ...(input.output ? { output: input.output } : {}),
    ...(input.types ? { types: input.types } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(Object.keys(selection.projections).length ? {
      projections: Object.fromEntries(Object.entries(selection.projections).map(([name, projection]) => [
        name, { expr: projection.expression, ...(projection.description ? { description: projection.description } : {}) }
      ]))
    } : {}),
    ...(input.where ? { where: input.where } : {}),
    ...(selection.select ? { select: selection.select } : {}),
    ...(input.orderBy ? { order_by: input.orderBy.map(order => ({ ...order, field: selection.field(order.field) })) } : {}),
    ...(input.groupBy ? { group_by: input.groupBy.map(order => ({ ...order, field: selection.field(order.field) })) } : {}),
    ...(input.summaryFunctions ? {
      summary_functions: Object.fromEntries(Object.entries(input.summaryFunctions).map(([name, projection]) => [
        name, { expr: projection.expression, ...(projection.description ? { description: projection.description } : {}) }
      ]))
    } : {}),
    ...(input.summaries ? { summaries: input.summaries.map(summary => ({ ...summary, field: selection.field(summary.field) })) } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.pagination ? { pagination: input.pagination } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(input.includeBody === undefined ? {} : { include_body: input.includeBody }),
    ...(input.frontmatterMode ? { frontmatter_mode: input.frontmatterMode } : {}),
    ...(input.contract ? { contract: input.contract } : {})
  };
}

export function wireDataContractIdentity(value: WireIdentity): DataContractViewIdentity {
  return {
    id: value.id, version: value.version, digest: value.digest,
    type: value.type, implementationDigest: value.implementation_digest
  };
}

export function wireQueryRecord<Frontmatter extends JsonObject>(value: WireQueryRecord<Frontmatter>): QueryRecord<Frontmatter> {
  const { effective_frontmatter, contract, ...record } = value;
  return {
    ...record,
    ...(effective_frontmatter === undefined ? {} : { effectiveFrontmatter: effective_frontmatter }),
    ...(contract ? { contract: wireDataContractIdentity(contract) } : {})
  };
}

function metadataRecord(value: import("@mdbase-dev/connect-protocol").QueryMetadataRecord): QueryMetadataRecord {
  if (!value || typeof value.path !== "string" || typeof value.revision !== "string" || !value.revision
      || !Array.isArray(value.types) || value.types.some(type => typeof type !== "string")
      || !value.values || typeof value.values !== "object" || Array.isArray(value.values)
      || Object.keys(value).some(key => !["path", "types", "revision", "values", "contract"].includes(key))
      || (value.contract !== undefined && (!value.contract
        || ["id", "version", "digest", "type", "implementation_digest"].some(key => typeof value.contract![key as keyof WireIdentity] !== "string")))) {
    throw connectError("invalid_operation_response", "The authority returned an invalid revision-bearing metadata row.");
  }
  return {
    path: value.path, types: value.types, revision: value.revision, values: value.values,
    ...(value.contract ? { contract: wireDataContractIdentity(value.contract) } : {})
  };
}

export function wireQueryResult<Frontmatter extends JsonObject>(
  value: WireQueryResult<Frontmatter>, output: "metadata" | undefined, input?: QueryInput | QueryMetadataInput
): QueryResult<Frontmatter> | QueryMetadataResult {
  if (!value || !Array.isArray(value.results) || value.output !== output) {
    throw connectError("invalid_operation_response", "The authority returned an invalid query output mode.");
  }
  const aliases = input ? querySelections(input).aliases : new Map<string, string>();
  if (aliases.size) value = { ...value, results: value.results.map(row => ({
    ...row,
    ...(row.values ? { values: Object.fromEntries(Object.entries(row.values).map(([key, entry]) => [aliases.get(key) ?? key, entry])) } : {})
  })) };
  const meta = value.meta ? {
    ...(typeof value.meta.total_count === "number" ? { totalCount: value.meta.total_count } : {}),
    ...(value.meta.total_count_outcome === undefined ? {} : { totalCountOutcome: value.meta.total_count_outcome }),
    hasMore: value.meta.has_more,
    ...(value.meta.cursor ? { cursor: value.meta.cursor } : {}),
    ...(value.meta.snapshot ? { snapshot: value.meta.snapshot } : {})
  } : undefined;
  if (output === "metadata") return {
    output, results: value.results.map(row => metadataRecord(row as import("@mdbase-dev/connect-protocol").QueryMetadataRecord)),
    ...(meta ? { meta } : {})
  };
  return { results: value.results.map(row => wireQueryRecord(row as WireQueryRecord<Frontmatter>)), ...(meta ? { meta } : {}) };
}

export function wireCollectionDescription(value: WireDescription): CollectionDescription {
  if (!value || value.protocol_version !== 1 || typeof value.collection_id !== "string"
      || typeof value.display_name !== "string" || typeof value.spec_version !== "string"
      || !Array.isArray(value.operations) || !Array.isArray(value.types) || !Array.isArray(value.contracts)) {
    throw connectError("invalid_operation_response", "The authority returned an invalid collection description.");
  }
  return {
    authorityCapabilities: authorityCapabilities(value.authority_capabilities),
    protocolVersion: value.protocol_version, collectionId: value.collection_id,
    displayName: value.display_name, specVersion: value.spec_version,
    operations: value.operations, changeCursor: value.change_cursor, types: value.types,
    contracts: value.contracts.map(contract => ({
      contractType: contract.contract_type, id: contract.id, version: contract.version,
      digest: contract.digest, schema: contract.schema,
      ...(contract.binding_schema ? { bindingSchema: contract.binding_schema } : {}),
      implementations: contract.implementations.map(implementation => ({
        typeName: implementation.type_name, typeVersion: implementation.type_version,
        ...(implementation.type_path ? { typePath: implementation.type_path } : {}),
        digest: implementation.digest, fields: implementation.fields,
        ...(implementation.binding ? { binding: implementation.binding } : {})
      }))
    })),
    ...(value.configuration ? { configuration: value.configuration } : {})
  };
}
