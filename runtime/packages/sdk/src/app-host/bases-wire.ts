/** Internal read-only Bases codec. Sole grammar: native app/bases.rs + shared
 * native byte fixtures. Independent optional windows, not cursor/lease proof.
 * Dates/display/duration provenance is preserved, never inferred in JavaScript. */
import { decode, encode, Float64, type CborValue } from "../cbor.js";
import { SchemaError, bool, hash, int, uint, uuid } from "../codec.js";
import { revisionOf } from "../values.js";
import { opClock, problem, type Hash, type OpClock, type Problem, type Uuid } from "../wire.js";
export const APP_BASES_PROFILE = "whole-view-synthetic-policy-reference-v1";
const FRAME_MAX = 16 * 1024 * 1024, REQUEST_MAX = 128 * 1024;
const TEXT_MAX = 4096, ITEMS_MAX = 4096, ROWS_MAX = 65536;
const utf8 = new TextEncoder();
const bad = (message: string, unknown = false) => new SchemaError("app-bases-v1", message, unknown);
function text(c: CborValue | undefined, max = TEXT_MAX): string {
  if (typeof c !== "string" || utf8.encode(c).length > max) throw bad("bounded text required");
  return c;
}
function unsigned(c: CborValue | undefined, max: number): number {
  const value = uint.dec(c!); if (value > max) throw bad("integer exceeds bound"); return value;
}
function list(c: CborValue | undefined, max: number): CborValue[] {
  if (!Array.isArray(c) || c.length > max) throw bad("bounded array required"); return c;
}
function tuple(c: CborValue | undefined, size: number): CborValue[] {
  const a = list(c, size); if (a.length !== size) throw bad("wrong tuple length"); return a;
}
function fields(c: CborValue | undefined, keys: readonly number[]): Map<number, CborValue> {
  if (!(c instanceof Map)) throw bad("exact struct required");
  const m = c as Map<unknown, CborValue>;
  if (m.size !== keys.length || keys.some(k => !m.has(k))) throw bad("exact struct required");
  return c as Map<number, CborValue>;
}
function float(c: CborValue | undefined): number {
  const value = c instanceof Float64 ? c.value : c;
  // Canonical shared CBOR decodes integral f64 (including -0) as Float64.
  // An integer major-type number is NOT a native f64 cell.
  if (typeof value !== "number" || !Number.isFinite(value) || (!(c instanceof Float64) && Number.isInteger(value))) throw bad("finite binary64 required");
  return value;
}
export type AppBasesCell =
  | {kind: "null"}
  | {kind: "boolean"; value: boolean}
  | {kind: "number"; value: number}
  | {kind: "text"; value: string}
  | {kind: "date"; millis: number; display: string; authoritativeZone: string; dateOnly: boolean}
  | {kind: "duration"; components: readonly [number, number, number, number, number, number, number, number]; display: string}
  | {kind: "list"; values: readonly AppBasesCell[]}
  | {kind: "map"; values: ReadonlyMap<string, AppBasesCell>}
  | {kind: "error"; message: string}
  | {kind: "unavailable"; code: string; detail: string};
export type AppBasesScalar = Exclude<AppBasesCell, {kind: "list" | "map" | "error" | "unavailable"}>;
/** Same tagged grammar for row cells and group keys. Value depth counts the
 * actual native value tree, not incidental CBOR tuple/map nesting. */
export function decodeAppBasesCell(c: CborValue, depth = 1): AppBasesCell {
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw bad("cell depth exceeds bound");
  const a = list(c, 5), tag = uint.dec(a[0]!);
  const exact = (n: number) => {if (a.length !== n) throw bad("wrong tagged cell length");};
  switch (tag) {
    case 0: exact(1); return {kind: "null"};
    case 1: exact(2); return {kind: "boolean", value: bool.dec(a[1]!)};
    case 2: exact(2); return {kind: "number", value: float(a[1])};
    case 3: exact(2); return {kind: "text", value: text(a[1])};
    case 4: {
      exact(5); const millis = int.dec(a[1]!);
      if (!Number.isSafeInteger(millis)) throw bad("date millis exceeds JS-safe range");
      return {kind: "date", millis, display: text(a[2]), authoritativeZone: text(a[3]), dateOnly: bool.dec(a[4]!)};
    }
    case 5: {
      exact(3); const components = tuple(a[1], 8).map(float) as [number, number, number, number, number, number, number, number];
      return {kind: "duration", components, display: text(a[2])};
    }
    case 6: exact(2); return {kind: "list", values: list(a[1], ITEMS_MAX).map(v => decodeAppBasesCell(v, depth + 1))};
    case 7: {
      exact(2); if (!(a[1] instanceof Map) || a[1].size > ITEMS_MAX) throw bad("bounded cell data map required");
      const values = new Map<string, AppBasesCell>(); let previous: Uint8Array | null = null;
      for (const [k, v] of a[1]) {
        const key = text(k), bytes = utf8.encode(key);
        // Native BTreeMap order is UTF8/scalar order, not JS UTF16 sort order.
        if (previous && compareBytes(previous, bytes) >= 0) throw bad("cell data map keys must ascend");
        previous = bytes; values.set(key, decodeAppBasesCell(v, depth + 1));
      }
      return {kind: "map", values};
    }
    case 8: exact(2); return {kind: "error", message: text(a[1])};
    case 9: exact(3); return {kind: "unavailable", code: text(a[1]), detail: text(a[2])};
    default: throw bad("unknown tagged cell", true); // No invented Missing tag10.
  }
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
export interface AppBasesWindow {offset: number; limit: number}
export interface AppBasesGroupPlacement {globalGroupOrdinal: number; totalGroupRows: number; rowOrdinals: readonly number[]}
export interface AppBasesWindowInfo extends AppBasesWindow {totalMatchedRows: number; groupPlacements: readonly AppBasesGroupPlacement[]}
export interface AppBasesRequest {
  record: Uuid; sourceRevision: Hash; ordinal: number;
  hints: ReadonlyMap<string, string>; captureTimezone: string; window?: AppBasesWindow;
}
function checkedWindow(window: AppBasesWindow): AppBasesWindow {
  const offset = unsigned(window.offset, 0xffffffff), limit = unsigned(window.limit, ROWS_MAX);
  if (limit === 0) throw bad("window limit must be positive");
  return {offset, limit};
}
/** Fixed reference profile; never accepts a caller policy, source, AST, head,
 * budget or authority override. Native still performs capture/current READ. */
export function encodeAppBasesRequest(request: AppBasesRequest): Uint8Array {
  if (!(request.hints instanceof Map) || request.hints.size > ITEMS_MAX) throw bad("bounded hints map required");
  const hints = new Map<string, CborValue>(); let total = 0;
  for (const [key, value] of request.hints) {
    text(key); text(value); total += utf8.encode(key).length + utf8.encode(value).length;
    if (total > 65536) throw bad("hint bytes exceed bound"); hints.set(key, value);
  }
  const value = new Map<number, CborValue>([
    [0, uuid.enc(request.record)], [1, hash.enc(request.sourceRevision)],
    [2, unsigned(request.ordinal, 0xffffffff)], [3, hints],
    [4, text(request.captureTimezone, 128)], [5, APP_BASES_PROFILE],
  ]);
  if (request.window !== undefined) {
    const window = checkedWindow(request.window);
    value.set(6, new Map<number, CborValue>([[0, window.offset], [1, window.limit]]));
  }
  const bytes = encode(value); if (bytes.length > REQUEST_MAX) throw bad("request bytes exceed bound"); return bytes;
}
export interface AppBasesDescriptor {
  record: Uuid; path: string; sourceRevision: Hash; ordinal: number;
  name: string | null; viewType: string;
  implementations: readonly {typeName: string; version: string; contractDigest: Hash; implementationDigest: Hash}[];
}
function decodeDescriptor(value: CborValue | undefined): AppBasesDescriptor {
  const d = fields(value, [0, 1, 2, 3, 4, 5, 6]);
  return {
    record: uuid.dec(d.get(0)!), path: text(d.get(1)), sourceRevision: hash.dec(d.get(2)!), ordinal: unsigned(d.get(3), 0xffffffff),
    name: d.get(4) === null ? null : text(d.get(4)), viewType: text(d.get(5)),
    implementations: list(d.get(6), ITEMS_MAX).map(v => {
      const i = fields(v, [0, 1, 2, 3]);
      return {typeName: text(i.get(0)), version: text(i.get(1)), contractDigest: hash.dec(i.get(2)!), implementationDigest: hash.dec(i.get(3)!)};
    }),
  };
}
export interface AppBasesRow {record: Uuid; path: string; sourceRevision: Hash; cells: readonly AppBasesCell[]}
export type AppBasesResult =
  | {kind: "refusal"; problem: Problem}
  | {kind: "success"; view: AppBasesDescriptor;
      columns: readonly string[]; unavailableColumns: readonly {index: number; code: string; detail: string}[];
      rows: readonly AppBasesRow[]; groups: readonly {key: AppBasesScalar; rowIndices: readonly number[]}[];
      clock: OpClock; collectionRevision: Hash; window?: AppBasesWindowInfo};
/** ONE complete success OR shared native Problem. Byte/frame admission precedes
 * generic canonical CBOR allocation; typed bounds precede typed result copies.
 * No partial publication, JS sorting/grouping/date math or readiness inference. */
export function decodeAppBasesResult(bytes: Uint8Array, expectedWindow?: AppBasesWindow | null): AppBasesResult {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > FRAME_MAX) throw bad("response bytes exceed bound");
  const decoded = decode(bytes);
  if (!(decoded instanceof Map)) throw bad("result struct required");
  const value = decoded as Map<number, CborValue>;
  if (value.get(0) !== 1) throw bad("unknown result version", true);
  if (value.has(7)) {const m = fields(value, [0, 7]); return {kind: "refusal", problem: problem.dec(m.get(7)!)};}
  const hasWindow = value.has(8);
  const m = fields(value, hasWindow ? [0, 1, 2, 3, 4, 5, 6, 8] : [0, 1, 2, 3, 4, 5, 6]);
  if (expectedWindow !== undefined && hasWindow !== (expectedWindow !== null)) throw bad("window response differs from request");
  const view = decodeDescriptor(m.get(1));
  const columnsWire = fields(m.get(2), [0, 1]), columns = list(columnsWire.get(0), 64).map(v => text(v));
  const unavailableColumns = list(columnsWire.get(1), 64).map(v => {
    const i = fields(v, [0, 1, 2]), index = unsigned(i.get(0), 63);
    if (index >= columns.length) throw bad("unavailable column index out of bounds");
    return {index, code: text(i.get(1)), detail: text(i.get(2))};
  });
  const rows = list(m.get(3), ROWS_MAX).map(v => {
    const row = tuple(v, 4), cells = list(row[3], 64);
    if (cells.length !== columns.length) throw bad("row cell count differs from columns");
    return {record: uuid.dec(row[0]!), path: text(row[1]), sourceRevision: hash.dec(row[2]!), cells: cells.map(v => decodeAppBasesCell(v))};
  });
  const groups = list(m.get(4), ROWS_MAX).map(v => {
    const group = tuple(v, 2), key = decodeAppBasesCell(group[0]!);
    if (key.kind === "list" || key.kind === "map" || key.kind === "error" || key.kind === "unavailable") throw bad("group key must be scalar");
    const rowIndices = list(group[1], ROWS_MAX).map(v => {
      const index = unsigned(v, ROWS_MAX - 1); if (index >= rows.length) throw bad("group row index out of bounds"); return index;
    });
    return {key, rowIndices};
  });
  let window: AppBasesWindowInfo | undefined;
  if (hasWindow) {
    const w = fields(m.get(8), [0, 1, 2, 3]);
    const requested = checkedWindow({offset: unsigned(w.get(0), 0xffffffff), limit: unsigned(w.get(1), ROWS_MAX)});
    const totalMatchedRows = unsigned(w.get(2), ROWS_MAX);
    if (rows.length !== Math.min(requested.limit, Math.max(totalMatchedRows - requested.offset, 0))) throw bad("window row count differs from total/request");
    if (expectedWindow != null) {
      const expected = checkedWindow(expectedWindow);
      if (requested.offset !== expected.offset || requested.limit !== expected.limit) throw bad("window echo differs from request");
    }
    let previous = -1;
    const placements = list(w.get(3), ROWS_MAX);
    if (placements.length !== groups.length || groups.some(group => group.rowIndices.length === 0)) throw bad("group placements must align represented groups");
    const groupPlacements = placements.map((v, index) => {
      const p = tuple(v, 3), globalGroupOrdinal = unsigned(p[0], ROWS_MAX - 1), totalGroupRows = unsigned(p[1], ROWS_MAX);
      if (globalGroupOrdinal <= previous || globalGroupOrdinal >= totalMatchedRows || totalGroupRows === 0 || totalGroupRows > totalMatchedRows) throw bad("group placement bounds/order invalid");
      previous = globalGroupOrdinal;
      let previousRow = -1;
      const rowOrdinals = list(p[2], ROWS_MAX).map(v => {
        const ordinal = unsigned(v, ROWS_MAX - 1);
        if (ordinal <= previousRow || ordinal >= totalGroupRows) throw bad("group row ordinal bounds/order invalid");
        previousRow = ordinal; return ordinal;
      });
      if (rowOrdinals.length !== groups[index]!.rowIndices.length) throw bad("group ordinal count differs from represented rows");
      return {globalGroupOrdinal, totalGroupRows, rowOrdinals};
    });
    window = {...requested, totalMatchedRows, groupPlacements};
  }
  const clock = opClock.dec(m.get(5)!);
  if (!Number.isSafeInteger(clock.instant)) throw bad("clock instant exceeds JS-safe range");
  return {kind: "success", view, columns, unavailableColumns, rows, groups, clock, collectionRevision: hash.dec(m.get(6)!), ...(window === undefined ? {} : {window})};
}

/** Native discovery is a separate same-cut continuation, never a Query cursor. */
export interface AppBasesDiscoveryRequest {captureTimezone: string; limit: number; continuation?: Uint8Array | null}
export interface AppBasesSourceRequest {record: Uuid; sourceRevision: Hash; ordinal: number; captureTimezone: string}
export type AppBasesDiscoveryResult =
  | {kind: "refusal"; problem: Problem}
  | {kind: "success"; views: readonly AppBasesDescriptor[]; clock: OpClock; collectionRevision: Hash; continuation: Uint8Array | null};
export type AppBasesSourceResult =
  | {kind: "refusal"; problem: Problem}
  | {kind: "success"; view: AppBasesDescriptor; source: string; clock: OpClock; collectionRevision: Hash};
function discoveryHandle(value: Uint8Array | null | undefined): Uint8Array | null {
  if (value == null) return null;
  if (!(value instanceof Uint8Array) || value.length !== 32) throw bad("native discovery handle must be 32 bytes");
  return new Uint8Array(value);
}
export function encodeAppBasesDiscoveryRequest(request: AppBasesDiscoveryRequest): Uint8Array {
  const limit = unsigned(request.limit, 128); if (!limit) throw bad("discovery limit must be positive");
  return encode(new Map<number, CborValue>([[0, 1], [1, text(request.captureTimezone, 128)], [2, limit], [3, discoveryHandle(request.continuation)]]));
}
export function encodeAppBasesSourceRequest(request: AppBasesSourceRequest): Uint8Array {
  return encode(new Map<number, CborValue>([[0, 1], [1, uuid.enc(request.record)], [2, hash.enc(request.sourceRevision)], [3, unsigned(request.ordinal, 0xffffffff)], [4, text(request.captureTimezone, 128)]]));
}
function discoveryEnvelope(bytes: Uint8Array): Map<number, CborValue> {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 1024 * 1024) throw bad("discovery response bytes exceed bound");
  const decoded = decode(bytes); if (!(decoded instanceof Map)) throw bad("discovery result struct required");
  const value = decoded as Map<number, CborValue>;
  if (value.get(0) !== 1) throw bad("unknown discovery result version");
  return value;
}
function discoveryDescriptor(value: CborValue | undefined): AppBasesDescriptor {
  const descriptor = decodeDescriptor(value);
  if (!descriptor.implementations.length || descriptor.implementations.length > 16) throw bad("bounded native implementation provenance required");
  return descriptor;
}
function discoveryClock(value: CborValue | undefined): OpClock {
  const clock = opClock.dec(value!); if (!Number.isSafeInteger(clock.instant)) throw bad("clock instant exceeds JS-safe range");
  text(clock.tz,128); text(clock.localDate,128); return clock;
}
export function decodeAppBasesDiscoveryResult(bytes: Uint8Array, expectedLimit = 128): AppBasesDiscoveryResult {
  const limit = unsigned(expectedLimit,128); if (!limit) throw bad("discovery limit must be positive");
  const value = discoveryEnvelope(bytes);
  if (value.has(7)) {const m = fields(value,[0,7]); return {kind:"refusal",problem:problem.dec(m.get(7)!)};}
  const m = fields(value,[0,1,2,3,4]);
  const views = list(m.get(1),limit).map(discoveryDescriptor);
  for (let i = 1; i < views.length; i++) {
    const previous = views[i-1]!, next = views[i]!;
    if (previous.record > next.record || (previous.record === next.record && previous.ordinal >= next.ordinal)) throw bad("discovery source/ordinal frontier must ascend");
    if (previous.record === next.record && (previous.path !== next.path || previous.sourceRevision !== next.sourceRevision)) throw bad("one source identity cannot have two revisions/paths within a page");
  }
  const token = m.get(4); if (token !== null && !(token instanceof Uint8Array)) throw bad("native discovery handle required");
  return {kind:"success",views,clock:discoveryClock(m.get(2)),collectionRevision:hash.dec(m.get(3)!),continuation:discoveryHandle(token as Uint8Array|null)};
}
export function decodeAppBasesSourceResult(bytes: Uint8Array, expected?: AppBasesSourceRequest): AppBasesSourceResult {
  const value = discoveryEnvelope(bytes);
  if (value.has(7)) {const m = fields(value,[0,7]); return {kind:"refusal",problem:problem.dec(m.get(7)!)};}
  const m = fields(value,[0,1,2,3,4]), view = discoveryDescriptor(m.get(1)), source = text(m.get(2),512*1024);
  if (revisionOf(source) !== view.sourceRevision) throw bad("exact native source SHA differs from bytes");
  if (expected && (view.record !== uuid.dec(uuid.enc(expected.record)) || view.sourceRevision !== hash.dec(hash.enc(expected.sourceRevision)) || view.ordinal !== expected.ordinal)) throw bad("exact source identity/revision/ordinal differs from request");
  return {kind:"success",view,source,clock:discoveryClock(m.get(3)),collectionRevision:hash.dec(m.get(4)!)};
}
