import type { QueryResult, QueryResultRow } from "pg";

export interface DatabaseQueryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface DatabaseConnection extends DatabaseQueryable {
  /** A migration may bound one query independently; pool/runtime defaults stay unchanged. */
  query<R extends QueryResultRow = any>(text: string, values?: unknown[], queryTimeoutMs?: number): Promise<QueryResult<R>>;
  release(): void;
}

export interface DatabasePool extends DatabaseQueryable {
  end(): Promise<void>;
  connect(): Promise<DatabaseConnection>;
}
