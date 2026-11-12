/** Version-one canonical contract inspection; never an SDK field-map projector. */
import { hash, list, struct, tstr, uint, uuid } from "./codec.js";
import { fmMap, issue, queryResult, type FmMap, type Issue, type QueryResult as ExactQueryResult, type Uuid } from "./wire.js";
import type { JsonObject, QueryResult } from "./plain.js";

export interface ContractRef { id: string; version: string }
/** One implementing type's view of a record: contract fields by contract field name. */
export interface ContractProjection { typeName: string; fields: JsonObject; issues: Issue[] }
export interface ContractQueryRecord { id: Uuid; implementations: ContractProjection[] }
export interface ContractQueryResult { version: number; page: QueryResult; records: ContractQueryRecord[]; contractDigest: string }
interface ProjectionWire { typeName: string; fields: FmMap; issues: Issue[] }
interface QueryRecordWire { id: Uuid; implementations: ProjectionWire[] }
/** The answer as it travels; {@link ContractQueryResult} is its plain reading. */
export interface ContractQueryWire { version: number; page: ExactQueryResult; records: QueryRecordWire[]; contractDigest: string }
export interface ContractQueryOptions {
  pageSize?: number;
  cursor?: string;
  signal?: AbortSignal;
  /** CEL over each projection's contract fields, in the record `where` dialect
   * (contract fields are top-level names; `file.*` is the record's file). Non-matching
   * projections and records are dropped, so a page may hold fewer than `pageSize`
   * records while `cursor` continues; `totalCount` is absent. Bound to the cursor. */
  where?: string;
}

export const contractQueryResult = struct<ContractQueryWire>("contract-query-v1", [
  [0, "version", uint], [1, "page", queryResult],
  [2, "records", list(struct<QueryRecordWire>("contract-query-record", [
    [0, "id", uuid], [1, "implementations", list(struct<ProjectionWire>("contract-projection", [
      [0, "typeName", tstr], [1, "fields", fmMap], [2, "issues", list(issue)],
    ]))],
  ]))],
  [3, "contractDigest", hash],
]);
