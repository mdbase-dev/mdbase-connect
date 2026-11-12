/** Spec 11/12 saved views (`mdbase.view` records) over the replica's served
 * `query_contract_v1`, `get_contract_v1`, `get` and `query` methods. A named view
 * resolves to an ordinary query (spec 11 "Named-view resolution"); the native
 * runtime serves no `list_views`/`execute_view`/`read_view_source` RPC. */
import type {MdbaseClient, Query, RecordRef} from "./client.js";
import {isMdbaseError, mdbaseError} from "./errors.js";
import type { Include, Issue, ViewProperty, ViewSourceDocument } from "./wire.js";
import { fieldOf, type JsonObject, type JsonValue, type QueryResult, type ViewDescriptor, type ViewSource } from "./plain.js";

export const SAVED_VIEW_CONTRACT = Object.freeze({id: "mdbase.view", version: "1.0.0"});

export interface ListViewsResult { sources: ViewSource[]; diagnostics: Issue[]; complete: boolean }
export interface ExecuteViewOptions {
  context?: RecordRef; limit?: number; offset?: number; timezone?: string; include?: Include; signal?: AbortSignal;
}
type Client = Pick<MdbaseClient, "queryContract" | "getContract" | "get" | "query">;

const map = (v: JsonValue | undefined): JsonObject | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const text = (v: JsonValue | undefined): string | undefined => typeof v === "string" ? v : undefined;
const warning = (code: string, message: string, path: string): Issue => ({code, severity: "warning", message, details: {path}});
const notFound = (e: unknown, path: string): never => {
  if (isMdbaseError(e, "not_found")) throw mdbaseError("not_found", `saved view source '${path}' was not found`, "view_not_found");
  throw e;
};
const refPath = (ref: RecordRef): string => typeof ref === "string" ? ref : ref.path;

function properties(record: JsonObject, view: JsonObject): ViewProperty[] {
  const metadata = map(fieldOf(record, "properties"));
  const out: ViewProperty[] = [];
  for (const selection of list(fieldOf(view, "select"))) {
    const object = map(selection);
    const selector = text(selection);
    const key = object ? text(fieldOf(object, "name")) : selector?.slice(selector.lastIndexOf(".") + 1);
    if (!key) continue;
    const meta = map(fieldOf(metadata, object || !selector ? key : selector)) ?? map(fieldOf(metadata, key));
    const property: ViewProperty = {key};
    const label = text(fieldOf(object, "label")) ?? text(fieldOf(meta, "label"));
    const description = text(fieldOf(object, "description")) ?? text(fieldOf(meta, "description"));
    const format = text(fieldOf(meta, "format")), hidden = fieldOf(meta, "hidden");
    if (label !== undefined) property.label = label;
    if (description !== undefined) property.description = description;
    if (format !== undefined) property.format = format;
    if (typeof hidden === "boolean") property.hidden = hidden;
    out.push(property);
  }
  return out;
}

/** Every `mdbase.view` source, ascending by path, then source-defined view order.
 * A collection without the contract has no saved views. Invalid sources become
 * warnings, never a partial descriptor. */
export async function listSavedViews(client: Client, folder?: string, signal?: AbortSignal): Promise<ListViewsResult> {
  const sources: ViewSource[] = [], diagnostics: Issue[] = [];
  const prefix = folder ? folder.replace(/\/?$/, "/") : "";
  let cursor: string | undefined, complete = true;
  do {
    let page;
    try {
      page = await client.queryContract(SAVED_VIEW_CONTRACT, {...(cursor ? {cursor} : {}), ...(signal ? {signal} : {})});
    } catch (e) {
      if (isMdbaseError(e, "not_found") && e.reason === "data_contract_not_found") return {sources, diagnostics, complete: true};
      throw e;
    }
    complete &&= page.page.complete;
    page.records.forEach((contract, i) => {
      const record = page.page.records[i]!;
      if (!record.path.startsWith(prefix)) return;
      const projection = contract.implementations[0];
      const invalid = projection?.issues.find(issue => issue.severity === "error");
      if (!projection || invalid) {
        diagnostics.push(warning("invalid_view", invalid?.message ?? "View record does not implement mdbase.view.", record.path));
        return;
      }
      const fields = projection.fields, views: ViewDescriptor[] = [], ids = new Set<string>();
      for (const item of list(fieldOf(fields, "views"))) {
        const view = map(item), id = text(fieldOf(view, "id")), name = text(fieldOf(view, "name"));
        if (!view || !id || !name) continue;
        if (ids.has(id)) {
          diagnostics.push(warning("invalid_view", "View record contains duplicate named-view IDs.", record.path));
          return;
        }
        ids.add(id);
        const descriptor: ViewDescriptor = {id, name, properties: properties(fields, view)};
        const presentation = fieldOf(view, "presentation");
        if (presentation !== undefined) descriptor.presentation = presentation;
        views.push(descriptor);
      }
      sources.push({
        record: record.id,
        id: text(fieldOf(fields, "id")) ?? record.path,
        name: text(fieldOf(fields, "name")) ?? record.path,
        source: {path: record.path, format: SAVED_VIEW_CONTRACT.id, revision: record.revision, writable: true},
        views,
      });
    });
    cursor = page.page.cursor;
  } while (cursor);
  sources.sort((a, b) => a.source.path < b.source.path ? -1 : a.source.path > b.source.path ? 1 : 0);
  return {sources, diagnostics, complete};
}

/** Spec 11 named-view resolution, then one ordinary native query page. */
export async function executeSavedView(client: Client, source: RecordRef, viewId: string, o: ExecuteViewOptions = {}): Promise<QueryResult> {
  const signal = o.signal;
  const record = await client.getContract(source, SAVED_VIEW_CONTRACT, signal).catch(e => notFound(e, refPath(source)));
  const fields = record.fields, path = record.path;
  const views = list(fieldOf(fields, "views")).map(map);
  const ids = views.map(view => text(fieldOf(view, "id")));
  if (new Set(ids).size !== ids.length) throw mdbaseError("invalid_request", "View record contains duplicate named-view IDs.", "invalid_view");
  const view = views[ids.indexOf(viewId)];
  if (!view) throw mdbaseError("not_found", `named view '${viewId}' was not found`, "view_not_found");
  const shared = map(fieldOf(fields, "query"));
  const query = new Map<string, JsonValue>();
  const types = fieldOf(view, "types") ?? fieldOf(shared, "types");
  if (types !== undefined) query.set("types", types);
  const wheres = [text(fieldOf(shared, "where")), text(fieldOf(view, "where"))].filter((w): w is string => !!w);
  if (wheres.length) query.set("where", wheres.length === 2 ? `(${wheres[0]}) && (${wheres[1]})` : wheres[0]!);
  const projections = new Map(Object.entries(map(fieldOf(shared, "projections")) ?? {}));
  for (const [name, definition] of Object.entries(map(fieldOf(view, "projections")) ?? {})) {
    const existing = projections.get(name);
    if (existing !== undefined && canonical(existing) !== canonical(definition))
      throw mdbaseError("invalid_request", `Projection '${name}' has conflicting definitions.`, "invalid_view");
    projections.set(name, definition);
  }
  if (projections.size) query.set("projections", Object.fromEntries(projections));
  for (const key of ["select", "order_by", "group_by", "summaries", "limit", "offset", "include_body", "frontmatter_mode"]) {
    const value = fieldOf(view, key);
    if (value !== undefined) query.set(key, value);
  }
  const summaryFunctions = fieldOf(fields, "summary_functions");
  if (summaryFunctions !== undefined) query.set("summary_functions", summaryFunctions);
  if (o.limit !== undefined) query.set("limit", o.limit);
  if (o.offset !== undefined) query.set("offset", o.offset);
  if (o.timezone !== undefined) query.set("timezone", o.timezone);
  const declaration = map(fieldOf(map(fieldOf(view, "context") ?? fieldOf(shared, "context")), "this"));
  const onMissing = text(fieldOf(declaration, "on_missing")) ?? "view";
  let context: RecordRef | undefined = o.context;
  if (context === undefined && onMissing === "error") throw mdbaseError("invalid_request", "This named view requires an invocation context.", "context_required");
  if (context === undefined && onMissing === "view") context = {path};
  if (context !== undefined) {
    const required = list(fieldOf(declaration, "types")).filter((t): t is string => typeof t === "string");
    let contextPath = typeof context === "string" ? undefined : context.path;
    if (required.length || contextPath === undefined) {
      const bound = await client.get(context, undefined, signal);
      contextPath = bound.path;
      if (required.length && !bound.types.some(t => required.some(r => r.toLowerCase() === t.toLowerCase())))
        throw mdbaseError("invalid_request", "The invocation context does not match an allowed context type.", "context_type_mismatch");
    }
    query.set("context", {this: {path: contextPath}});
  }
  const result = await client.query(Object.fromEntries(query) as Query, o.include, signal);
  return {...result, view: {path, view: viewId}};
}

/** The complete current source document of one `mdbase.view` record. */
export async function readSavedViewSource(client: Client, source: RecordRef, signal?: AbortSignal): Promise<ViewSourceDocument> {
  const contract = await client.getContract(source, SAVED_VIEW_CONTRACT, signal).catch(e => notFound(e, refPath(source)));
  const record = await client.get(contract.id, {document: true}, signal);
  if (record.revision !== contract.revision || typeof record.document !== "string")
    throw mdbaseError("unavailable", "saved view source changed while it was read", "view_source_changed");
  return {path: record.path, format: SAVED_VIEW_CONTRACT.id, revision: record.revision, document: record.document, record: record.id};
}

/** One text for a projection whatever order its keys were written in. */
function canonical(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k]!)}`).join(",")}}`;
  return JSON.stringify(v);
}
