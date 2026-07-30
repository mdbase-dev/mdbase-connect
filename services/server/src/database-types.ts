import type { QueryResult, QueryResultRow } from "pg";

export interface DatabaseQueryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export interface DatabaseConnection extends DatabaseQueryable {
  release(): void;
}

export interface DatabasePool extends DatabaseQueryable {
  end(): Promise<void>;
  connect(): Promise<DatabaseConnection>;
}
