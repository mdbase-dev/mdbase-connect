// MCP tool inputs/outputs <-> mdbase-next replica API. The tool surface (names,
// input schemas, output shapes) stays the legacy authority's; this module is the
// only place the two vocabularies meet. Pure functions: golden-tested per input.
import { toPlain, type ContractQueryResult, type Include, type QueryResult, type RecordView, type RecordValidation, type wire } from "@mdbase-dev/sdk";
import { GatewayOperationError } from "./errors.js";

type ChangesResult = wire.ChangesResult;
type DescribeResult = wire.DescribeResult;
type ResourceView = wire.ResourceView;

type Json = Record<string, unknown>;
const plain = (value: unknown) => toPlain(value as Parameters<typeof toPlain>[0]);

/** Spec 11 members the replica parses natively, passed through unchanged. */
const QUERY_PASSTHROUGH = [
  "types", "timezone", "context", "projections", "where", "select", "order_by",
  "group_by", "summary_functions", "summaries", "limit", "offset", "cursor"
] as const;
/** Legacy members with no native counterpart: hosted cursors are already snapshot
 * bound, and the replica returns a cursor whenever more rows remain. */
const QUERY_DROPPED = ["pagination", "snapshot"] as const;
/** Members that select the output shape rather than the query. */
const QUERY_SHAPE = ["output", "include_body", "frontmatter_mode", "contract"] as const;

type FrontmatterMode = "effective" | "persisted" | "both";
interface ContractSelector { id: string; version: string; type?: string }

type NextQueryPlan =
  | { kind: "query"; query: Json; include: Include; output?: "metadata"; mode: FrontmatterMode }
  | { kind: "contract"; contract: ContractSelector; pageSize?: number; cursor?: string; where?: string; includeBody: false };

export function nextQueryPlan(input: Json): NextQueryPlan {
  const known = new Set<string>([...QUERY_PASSTHROUGH, ...QUERY_DROPPED, ...QUERY_SHAPE]);
  for (const key of Object.keys(input)) if (!known.has(key)) throw invalid(`Unknown query member ${key}.`);
  if (input.output !== undefined && input.output !== "metadata") throw invalid("output must be metadata.");
  if (input.output === "metadata" && input.include_body === true) throw invalid("Metadata output cannot include body hydration.");
  const mode = (input.frontmatter_mode ?? "effective") as FrontmatterMode;
  if (!["effective", "persisted", "both"].includes(mode)) throw invalid("frontmatter_mode must be effective, persisted or both.");
  if (input.contract !== undefined) {
    const contract = input.contract as ContractSelector;
    if (!contract || typeof contract !== "object" || typeof contract.id !== "string" || typeof contract.version !== "string") {
      throw invalid("contract needs id and version.");
    }
    const extra = Object.keys(input).filter((key) => input[key] !== undefined && !["contract", "where", "limit", "cursor", "pagination", "snapshot", "frontmatter_mode"].includes(key));
    if (extra.length) throw invalid(`A contract query accepts where, limit and cursor only (not ${extra.join(", ")}).`);
    if (input.where !== undefined && typeof input.where !== "string") throw invalid("where is a CEL string.");
    const limit = input.limit as number | undefined;
    return {
      kind: "contract", contract, includeBody: false,
      ...(limit === undefined ? {} : { pageSize: Math.min(limit, 128) }),
      ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
      ...(typeof input.where === "string" ? { where: input.where } : {})
    };
  }
  const query: Json = {};
  for (const key of QUERY_PASSTHROUGH) if (input[key] !== undefined) query[key] = input[key];
  const metadata = input.output === "metadata";
  return {
    kind: "query", query, mode,
    include: metadata ? { effective: false, body: false } : { effective: mode !== "persisted", body: input.include_body === true },
    ...(metadata ? { output: "metadata" as const } : {})
  };
}

function file(view: RecordView): Json {
  const slash = view.path.lastIndexOf("/");
  return {
    path: view.path,
    name: view.path.slice(slash + 1).replace(/\.md$/u, ""),
    folder: slash < 0 ? "" : view.path.slice(0, slash),
    ...(view.mtime === undefined ? {} : { mtime: new Date(view.mtime).toISOString() })
  };
}

function frontmatter(view: RecordView, mode: FrontmatterMode): Json {
  const persisted = plain(view.frontmatter) as Json;
  const effective = view.effective ? plain(view.effective) as Json : persisted;
  if (mode === "persisted") return { frontmatter: persisted };
  if (mode === "effective") return { frontmatter: effective };
  return { frontmatter: persisted, effective_frontmatter: effective };
}

/** Legacy `QueryRecord`. */
function queryRecord(view: RecordView, mode: FrontmatterMode = "effective"): Json {
  return {
    path: view.path, revision: view.revision, ...frontmatter(view, mode),
    ...(view.body === undefined ? {} : { body: view.body }),
    types: view.types, file: file(view),
    ...(view.values ? { values: plain(view.values) } : {})
  };
}

/** Legacy `RecordDocument` (read, create, update, rename). */
export function recordDocument(view: RecordView): Json {
  const persisted = plain(view.frontmatter) as Json;
  return {
    path: view.path, revision: view.revision, types: view.types,
    frontmatter: persisted, effective_frontmatter: view.effective ? plain(view.effective) : persisted,
    ...(view.body === undefined ? {} : { body: view.body }),
    ...(view.document === undefined ? {} : { document: view.document }),
    file: file(view)
  };
}

function meta(result: QueryResult): Json {
  return {
    ...(result.totalCount === undefined ? {} : { total_count: result.totalCount }),
    has_more: result.hasMore ?? result.cursor !== undefined,
    ...(result.cursor ? { cursor: result.cursor } : {}),
    ...(result.columns ? { columns: result.columns } : {}),
    ...(result.groups ? { groups: result.groups.map((group) => ({ values: plain(group.values), count: group.count, ...(group.summaries ? { summaries: plain(group.summaries) } : {}) })) } : {}),
    ...(result.complete ? {} : { complete: false })
  };
}

export function queryOutput(plan: Extract<NextQueryPlan, { kind: "query" }>, result: QueryResult): Json {
  if (plan.output === "metadata") {
    return {
      output: "metadata",
      results: result.records.map((view) => ({ path: view.path, types: view.types, revision: view.revision, values: view.values ? plain(view.values) : {} })),
      meta: meta(result)
    };
  }
  return { results: result.records.map((view) => queryRecord(view, plan.mode)), meta: meta(result) };
}

/** Implementation digests by implementing type name for one contract, from describe. */
export function implementationDigests(contract: ContractSelector, description: DescribeResult): Map<string, string> {
  const digests = new Map<string, string>();
  for (const type of description.types) {
    const implementation = type.implements.find((candidate) => candidate.contract === contract.id && candidate.version === contract.version);
    if (implementation?.digest) digests.set(type.name, implementation.digest);
  }
  return digests;
}

export function contractQueryOutput(plan: Extract<NextQueryPlan, { kind: "contract" }>, result: ContractQueryResult, digests: ReadonlyMap<string, string>): Json {
  const projections = new Map(result.records.map((record) => [record.id, record.implementations]));
  return {
    results: result.page.records.flatMap((view) => {
      const projection = (projections.get(view.id) ?? []).find((candidate) => candidate.issues.length === 0 && (!plan.contract.type || candidate.typeName === plan.contract.type));
      if (!projection) return [];
      return [{
        path: view.path, revision: view.revision, types: view.types, file: file(view),
        frontmatter: plain(projection.fields),
        contract: {
          id: plan.contract.id, version: plan.contract.version, digest: result.contractDigest, type: projection.typeName,
          ...(digests.has(projection.typeName) ? { implementation_digest: digests.get(projection.typeName) } : {})
        }
      }];
    }),
    meta: meta(result.page)
  };
}

/** Legacy `CollectionDescription`. */
export function collectionDescription(input: { collectionId: string; displayName: string; operations: string[]; changeCursor: string }, result: DescribeResult): Json {
  return {
    authority_capabilities: ["query-metadata-v1", "query-record-revisions-v1"],
    protocol_version: 1,
    collection_id: input.collectionId,
    display_name: input.displayName,
    spec_version: result.specVersion,
    operations: input.operations,
    change_cursor: input.changeCursor,
    types: result.types.map((type) => ({
      name: type.name, path: type.path,
      ...(type.version === undefined ? {} : { version: type.version }),
      ...(type.revision === undefined ? {} : { revision: type.revision }),
      ...(type.definition === undefined ? {} : { definition: plain(type.definition) }),
      schema: type.schema === undefined ? {} : plain(type.schema),
      extensions: {}
    })),
    contracts: result.contracts.map((contract) => ({
      contract_type: contract.contractType, id: contract.id, version: contract.version, digest: contract.digest,
      schema: contract.schemas?.get("record_schema") === undefined ? {} : plain(contract.schemas.get("record_schema")),
      implementations: result.types.flatMap((type) => type.implements
        .filter((implementation) => implementation.contract === contract.id && implementation.version === contract.version)
        .map((implementation) => ({
          type_name: type.name, type_version: type.version ?? 1, type_path: type.path,
          ...(implementation.digest ? { digest: implementation.digest } : {}), fields: Object.fromEntries(implementation.fields)
        })))
    })),
    ...(result.settings === null || result.settings === undefined ? {} : { configuration: plain(result.settings) })
  };
}

/** Legacy changes page. As on the legacy authorities, no `after` answers no events
 * and the current cursor, and pages default to 100 events. `after` was an integer
 * cursor; next cursors are opaque replica view versions, so an integer `after`
 * answers `reset: true`. */
const CHANGES_DEFAULT_LIMIT = 100;
export function changesInput(input: { after?: number | string; limit?: number }): { cursor?: string; limit: number } {
  return {
    ...(input.after === undefined ? {} : { cursor: String(input.after) }),
    limit: input.limit ?? CHANGES_DEFAULT_LIMIT
  };
}

export function changesOutput(result: ChangesResult, limit: number): Json {
  return {
    events: result.changes.map((change) => ({
      cursor: change.version,
      type: change.entity === "file"
        ? (change.kind === "put" ? "mdbase.file.put" : "mdbase.file.remove")
        : (change.kind === "put" ? "mdbase.record.modified" : "mdbase.record.deleted"),
      occurred_at: null,
      payload: { path: change.path }
    })),
    cursor: result.cursor,
    // The replica does not report more; a full page may be followed by an empty one.
    has_more: result.changes.length >= limit,
    reset: result.reset,
    ...(result.reset ? { reset_reason: "The change cursor is no longer valid (the collection restarted or the cursor is too old). Changes may have been missed: re-read the records you rely on, then continue from cursor." } : {})
  };
}

export function validationOutput(results: RecordValidation[]): Json {
  const issues = results.flatMap((record) => record.issues.map((issue) => ({
    path: record.path, code: issue.code, severity: issue.severity, message: issue.message,
    ...(issue.location ? { location: issue.location } : {}), ...(issue.typeName ? { type: issue.typeName } : {})
  })));
  return { valid: !issues.some((issue) => issue.severity === "error"), records_checked: results.length, issues };
}

export function typeDocument(name: string, resource: ResourceView): Json {
  return { name, path: resource.path, revision: resource.revision, document: resource.text ?? "" };
}

function invalid(message: string): GatewayOperationError {
  return new GatewayOperationError("invalid_request", message);
}
