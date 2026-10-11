/** Version-one canonical contract inspection; never an SDK field-map projector. */
import { hash, list, struct, tstr, uint, uuid } from "./codec.js";
import { fmMap, issue, queryResult, type FmMap, type Issue, type QueryResult, type Uuid } from "./wire.js";

export interface ContractRef { id: string; version: string }
export interface ContractProjection { typeName: string; fields: FmMap; issues: Issue[] }
export interface ContractQueryRecord { id: Uuid; implementations: ContractProjection[] }
export interface ContractQueryResult { version: number; page: QueryResult; records: ContractQueryRecord[]; contractDigest: string }
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

export const contractQueryResult = struct<ContractQueryResult>("contract-query-v1", [
  [0, "version", uint], [1, "page", queryResult],
  [2, "records", list(struct<ContractQueryRecord>("contract-query-record", [
    [0, "id", uuid], [1, "implementations", list(struct<ContractProjection>("contract-projection", [
      [0, "typeName", tstr], [1, "fields", fmMap], [2, "issues", list(issue)],
    ]))],
  ]))],
  [3, "contractDigest", hash],
]);
