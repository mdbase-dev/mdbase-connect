import pg, { type Pool, type QueryResult, type QueryResultRow } from "pg";

export interface DatabaseQueryable {
  query<Row extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export interface DatabaseConnection extends DatabaseQueryable {
  release(): void;
}

export interface DatabasePool extends DatabaseQueryable {
  connect(): Promise<DatabaseConnection>;
  end(): Promise<void>;
}

export async function createDatabase(databaseUrl = process.env.DATABASE_URL): Promise<DatabasePool> {
  let pool: DatabasePool;
  if (!databaseUrl || databaseUrl === "memory") {
    const { newDb } = await import("pg-mem");
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    pool = new adapter.Pool() as unknown as DatabasePool;
  } else {
    pool = new pg.Pool({ connectionString: databaseUrl }) as Pool;
  }
  await migrate(pool);
  return pool;
}

export async function migrate(db: DatabaseQueryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mcp_settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_clients (
      id text PRIMARY KEY,
      client_name text NOT NULL,
      redirect_uris jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_connection_sets (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_authorization_requests (
      id uuid PRIMARY KEY,
      client_id text NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      state text,
      code_challenge text NOT NULL,
      resource text NOT NULL,
      scopes jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      completed_at timestamptz,
      denied_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_upstream_authorizations (
      id uuid PRIMARY KEY,
      state_hash text NOT NULL UNIQUE,
      kind text NOT NULL CHECK (kind IN ('initial', 'additional')),
      authorization_request_id uuid REFERENCES mcp_authorization_requests(id) ON DELETE CASCADE,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      scopes jsonb NOT NULL,
      code_verifier text NOT NULL,
      key_handle text NOT NULL,
      expires_at timestamptz NOT NULL,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_grant_keys (
      handle text PRIMARY KEY,
      public_key text NOT NULL,
      private_key_ciphertext text NOT NULL,
      counter numeric(20, 0) NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_connections (
      id uuid PRIMARY KEY,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      upstream_url text NOT NULL,
      upstream_client_id uuid NOT NULL,
      collection_id uuid NOT NULL,
      grant_id uuid NOT NULL,
      display_name text NOT NULL,
      operations jsonb NOT NULL,
      scope jsonb NOT NULL,
      encryption jsonb,
      key_handle text REFERENCES mcp_grant_keys(handle) ON DELETE SET NULL,
      credentials_ciphertext text NOT NULL,
      access_expires_at timestamptz NOT NULL,
      refresh_expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(connection_set_id, upstream_url, collection_id)
    );
    CREATE TABLE IF NOT EXISTS mcp_authorization_codes (
      id uuid PRIMARY KEY,
      code_hash text NOT NULL UNIQUE,
      client_id text NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      resource text NOT NULL,
      scopes jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_access_tokens (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      client_id text NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      resource text NOT NULL,
      scopes jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      client_id text NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      resource text NOT NULL,
      scopes jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mcp_connection_tickets (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      connection_set_id uuid NOT NULL REFERENCES mcp_connection_sets(id) ON DELETE CASCADE,
      scopes jsonb NOT NULL,
      collection_hint uuid,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(
    "ALTER TABLE mcp_connection_tickets ADD COLUMN IF NOT EXISTS collection_hint uuid"
  );
}
