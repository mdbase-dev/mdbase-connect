import pg, { type Pool, type QueryResult, type QueryResultRow } from "pg";

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
  const connection = await pool.connect();
  const lockMigrations = Boolean(databaseUrl && databaseUrl !== "memory");
  try {
    if (lockMigrations) await connection.query("SELECT pg_advisory_lock($1)", [1_291_842_019]);
    await migrate(connection);
  } finally {
    if (lockMigrations) await connection.query("SELECT pg_advisory_unlock($1)", [1_291_842_019]);
    connection.release();
  }
  return pool;
}

export async function migrate(db: DatabaseQueryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email text UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS external_identities (
      provider text NOT NULL,
      subject text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      login text,
      email text,
      email_verified boolean NOT NULL DEFAULT false,
      avatar_url text,
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(provider, subject),
      UNIQUE(provider, user_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_login_states (
      id uuid PRIMARY KEY,
      provider text NOT NULL,
      state_hash text NOT NULL UNIQUE,
      return_to text NOT NULL,
      code_verifier text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      provider text NOT NULL DEFAULT 'session',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS connectors (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      relay_generation bigint NOT NULL DEFAULT 0,
      inventory_revision bigint NOT NULL DEFAULT 0,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS collections (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      local_id uuid NOT NULL,
      display_name text NOT NULL,
      spec_version text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      reported_enabled boolean NOT NULL DEFAULT true,
      present boolean NOT NULL DEFAULT true,
      authority_state text NOT NULL DEFAULT 'active'
        CHECK (authority_state IN ('active', 'candidate', 'retired')),
      authority_epoch bigint NOT NULL DEFAULT 1,
      contracts jsonb NOT NULL DEFAULT '[]'::jsonb,
      last_inventory_revision bigint NOT NULL DEFAULT 0,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      removed_at timestamptz,
      UNIQUE(connector_id, local_id)
    );
    CREATE TABLE IF NOT EXISTS hosted_collections (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name text NOT NULL,
      template text NOT NULL,
      provider_url text,
      contracts jsonb NOT NULL DEFAULT '[]'::jsonb,
      authority_state text NOT NULL DEFAULT 'active'
        CHECK (authority_state IN ('active', 'transferring', 'transferred')),
      authority_epoch bigint NOT NULL DEFAULT 1,
      transferred_collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS hosted_replicas (
      id uuid PRIMARY KEY,
      collection_id uuid NOT NULL REFERENCES hosted_collections(id) ON DELETE CASCADE,
      name text NOT NULL,
      purpose text NOT NULL DEFAULT 'mirror' CHECK (purpose IN ('mirror', 'application')),
      mode text NOT NULL CHECK (mode IN ('read_only', 'read_write')),
      allowed_types jsonb NOT NULL DEFAULT '[]'::jsonb,
      token_hash text UNIQUE,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS applications (
      id uuid PRIMARY KEY,
      canonical_identity text NOT NULL UNIQUE,
      family_identity text NOT NULL DEFAULT '',
      manifest_version integer NOT NULL DEFAULT 1,
      distribution text NOT NULL DEFAULT 'web'
        CHECK (distribution IN ('web', 'portable')),
      name text NOT NULL,
      homepage text NOT NULL,
      project_url text,
      icon text,
      redirect_uris jsonb NOT NULL,
      requirements jsonb NOT NULL DEFAULT '{"contracts":[]}'::jsonb,
      provisions jsonb NOT NULL DEFAULT '{"types":[]}'::jsonb,
      notifications jsonb NOT NULL DEFAULT '{"criteria":[]}'::jsonb,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS grants (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      collection_id uuid REFERENCES collections(id) ON DELETE CASCADE,
      hosted_collection_id uuid REFERENCES hosted_collections(id) ON DELETE CASCADE,
      hosted_replica_id uuid REFERENCES hosted_replicas(id) ON DELETE SET NULL,
      operations jsonb NOT NULL,
      scope jsonb NOT NULL DEFAULT '{"contracts":[],"access":"full_collection"}'::jsonb,
      notification_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
      encryption jsonb,
      proof_public_key text,
      application_origin text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      activated_at timestamptz DEFAULT now(),
      revoked_at timestamptz,
      CHECK ((collection_id IS NULL) <> (hosted_collection_id IS NULL))
    );
    CREATE TABLE IF NOT EXISTS authorization_requests (
      id uuid PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      grant_id uuid REFERENCES grants(id) ON DELETE CASCADE,
      flow text NOT NULL DEFAULT 'authorization_code'
        CHECK (flow IN ('authorization_code', 'device_code')),
      redirect_uri text,
      state text,
      code_challenge text,
      requested_operations jsonb NOT NULL,
      collection_hint uuid,
      relay_protocol integer,
      application_public_key text,
      device_code_hash text UNIQUE,
      user_code text,
      user_code_hash text UNIQUE,
      poll_interval_seconds integer NOT NULL DEFAULT 5,
      last_polled_at timestamptz,
      device_consumed_at timestamptz,
      expires_at timestamptz NOT NULL,
      activation_started_at timestamptz,
      completed_at timestamptz,
      denied_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS authorization_collection_offers (
      id uuid PRIMARY KEY,
      authorization_id uuid NOT NULL REFERENCES authorization_requests(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      local_id uuid NOT NULL,
      authority_epoch bigint NOT NULL,
      inventory_revision bigint NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(authorization_id, connector_id, collection_id)
    );
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id uuid PRIMARY KEY,
      secret_hash text NOT NULL UNIQUE,
      connector_name text NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      approved_at timestamptz,
      consumed_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mirror_pairing_requests (
      id uuid PRIMARY KEY,
      secret_hash text NOT NULL UNIQUE,
      mirror_name text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('read_only', 'read_write')),
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      collection_hint uuid,
      collection_id uuid REFERENCES hosted_collections(id) ON DELETE CASCADE,
      replica_id uuid UNIQUE,
      approved_at timestamptz,
      consumed_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS authority_transfers (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hosted_collection_id uuid NOT NULL REFERENCES hosted_collections(id) ON DELETE CASCADE,
      pairing_id uuid NOT NULL REFERENCES mirror_pairing_requests(id) ON DELETE CASCADE,
      replica_id uuid NOT NULL REFERENCES hosted_replicas(id) ON DELETE CASCADE,
      local_collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
      state text NOT NULL DEFAULT 'requested'
        CHECK (state IN ('requested', 'approved', 'prepared', 'completed', 'cancelled', 'expired')),
      final_head bigint,
      next_authority_epoch bigint,
      manifest_digest text,
      expires_at timestamptz NOT NULL,
      approved_at timestamptz,
      prepared_at timestamptz,
      completed_at timestamptz,
      cancelled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS authority_transfers_collection_idx
      ON authority_transfers(hosted_collection_id, state);
    CREATE TABLE IF NOT EXISTS authorization_codes (
      id uuid PRIMARY KEY,
      code_hash text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS access_tokens (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id uuid PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      subject_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS push_channels (
      id uuid PRIMARY KEY,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      installation_id text NOT NULL,
      kind text NOT NULL DEFAULT 'web_push',
      endpoint text,
      endpoint_hash text,
      p256dh text,
      auth text,
      fcm_project_id text,
      fcm_token text,
      fcm_token_hash text,
      expires_at timestamptz,
      disabled_at timestamptz,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(grant_id, installation_id),
      UNIQUE(grant_id, endpoint_hash)
    );
    CREATE TABLE IF NOT EXISTS notification_subscriptions (
      id uuid PRIMARY KEY,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      channel_id uuid NOT NULL REFERENCES push_channels(id) ON DELETE CASCADE,
      criterion_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(channel_id, criterion_id)
    );
    CREATE TABLE IF NOT EXISTS notification_signals (
      id uuid PRIMARY KEY,
      signal_id text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      criterion_id text NOT NULL,
      cursor text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id uuid PRIMARY KEY,
      signal_id uuid NOT NULL REFERENCES notification_signals(id) ON DELETE CASCADE,
      subscription_id uuid NOT NULL REFERENCES notification_subscriptions(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'discarded')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_token text,
      leased_until timestamptz,
      last_error text,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(signal_id, subscription_id)
    );
    CREATE INDEX IF NOT EXISTS notification_deliveries_ready_idx
      ON notification_deliveries(status, available_at);
    CREATE TABLE IF NOT EXISTS notification_webhook_deliveries (
      id uuid PRIMARY KEY,
      signal_id uuid NOT NULL UNIQUE REFERENCES notification_signals(id) ON DELETE CASCADE,
      url text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'discarded')),
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(),
      lease_token text,
      leased_until timestamptz,
      last_error text,
      delivered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS notification_webhook_deliveries_ready_idx
      ON notification_webhook_deliveries(status, available_at);
  `);
  const authorizationColumns = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'authorization_requests'`
  );
  if (!authorizationColumns.rows.some((column) => column.column_name === "denied_at")) {
    await db.query("ALTER TABLE authorization_requests ADD COLUMN denied_at timestamptz");
  }
  if (!authorizationColumns.rows.some((column) => column.column_name === "grant_id")) {
    await db.query("ALTER TABLE authorization_requests ADD COLUMN grant_id uuid REFERENCES grants(id) ON DELETE CASCADE");
  }
  await ensureColumn(
    db,
    "collections",
    "contracts",
    "ALTER TABLE collections ADD COLUMN contracts jsonb NOT NULL DEFAULT '[]'::jsonb"
  );
  await ensureColumn(
    db,
    "collections",
    "authority_state",
    "ALTER TABLE collections ADD COLUMN authority_state text NOT NULL DEFAULT 'active'"
  );
  await ensureColumn(
    db,
    "collections",
    "authority_epoch",
    "ALTER TABLE collections ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 1"
  );
  await ensureColumn(
    db,
    "connectors",
    "inventory_revision",
    "ALTER TABLE connectors ADD COLUMN inventory_revision bigint NOT NULL DEFAULT 0"
  );
  await ensureColumn(
    db,
    "collections",
    "user_id",
    "ALTER TABLE collections ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE"
  );
  await db.query(
    `UPDATE collections SET user_id = connectors.user_id
     FROM connectors WHERE collections.connector_id = connectors.id
       AND collections.user_id IS NULL`
  );
  await ensureNotNullable(db, "collections", "user_id");
  await ensureColumn(
    db,
    "collections",
    "present",
    "ALTER TABLE collections ADD COLUMN present boolean NOT NULL DEFAULT true"
  );
  await ensureColumn(
    db,
    "collections",
    "reported_enabled",
    "ALTER TABLE collections ADD COLUMN reported_enabled boolean NOT NULL DEFAULT true"
  );
  await ensureColumn(
    db,
    "collections",
    "last_inventory_revision",
    "ALTER TABLE collections ADD COLUMN last_inventory_revision bigint NOT NULL DEFAULT 0"
  );
  await ensureColumn(
    db,
    "collections",
    "removed_at",
    "ALTER TABLE collections ADD COLUMN removed_at timestamptz"
  );
  await ensureColumn(
    db,
    "applications",
    "manifest_version",
    "ALTER TABLE applications ADD COLUMN manifest_version integer NOT NULL DEFAULT 1"
  );
  await ensureColumn(
    db,
    "applications",
    "family_identity",
    "ALTER TABLE applications ADD COLUMN family_identity text DEFAULT ''"
  );
  const applicationsWithoutFamily = await db.query<{
    id: string;
    canonical_identity: string;
  }>(
    `SELECT id, canonical_identity FROM applications
     WHERE family_identity IS NULL OR family_identity = ''`
  );
  for (const application of applicationsWithoutFamily.rows) {
    await db.query(
      "UPDATE applications SET family_identity = $2 WHERE id = $1",
      [
        application.id,
        application.canonical_identity.replace(/:sha256:[a-f0-9]+$/i, "")
      ]
    );
  }
  await ensureNotNullable(db, "applications", "family_identity");
  await ensureColumn(
    db,
    "applications",
    "distribution",
    "ALTER TABLE applications ADD COLUMN distribution text NOT NULL DEFAULT 'web'"
  );
  await ensureColumn(
    db,
    "applications",
    "project_url",
    "ALTER TABLE applications ADD COLUMN project_url text"
  );
  const applicationColumns = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'applications'`
  );
  if (applicationColumns.rows.some((column) => column.column_name === "manifest_url")) {
    await db.query("ALTER TABLE applications DROP COLUMN manifest_url");
  }
  await ensureColumn(
    db,
    "applications",
    "notifications",
    "ALTER TABLE applications ADD COLUMN notifications jsonb NOT NULL DEFAULT '{\"criteria\":[]}'::jsonb"
  );
  await ensureColumn(
    db,
    "applications",
    "provisions",
    "ALTER TABLE applications ADD COLUMN provisions jsonb NOT NULL DEFAULT '{\"types\":[]}'::jsonb"
  );
  await ensureColumn(
    db,
    "applications",
    "requirements",
    "ALTER TABLE applications ADD COLUMN requirements jsonb NOT NULL DEFAULT '{\"contracts\":[]}'::jsonb"
  );
  await ensureColumn(
    db,
    "grants",
    "scope",
    "ALTER TABLE grants ADD COLUMN scope jsonb NOT NULL DEFAULT '{\"contracts\":[],\"access\":\"full_collection\"}'::jsonb"
  );
  await ensureColumn(
    db,
    "grants",
    "notification_criteria",
    "ALTER TABLE grants ADD COLUMN notification_criteria jsonb NOT NULL DEFAULT '[]'::jsonb"
  );
  await ensureColumn(
    db,
    "grants",
    "activated_at",
    "ALTER TABLE grants ADD COLUMN activated_at timestamptz DEFAULT now()"
  );
  await db.query(
    `UPDATE grants
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE scope->>'access' IS NULL`
  );
  await ensureColumn(db, "connectors", "relay_public_key", "ALTER TABLE connectors ADD COLUMN relay_public_key text");
  await ensureColumn(
    db,
    "connectors",
    "relay_generation",
    "ALTER TABLE connectors ADD COLUMN relay_generation bigint NOT NULL DEFAULT 0"
  );
  await ensureColumn(db, "grants", "encryption", "ALTER TABLE grants ADD COLUMN encryption jsonb");
  await ensureColumn(
    db,
    "grants",
    "application_origin",
    "ALTER TABLE grants ADD COLUMN application_origin text NOT NULL DEFAULT ''"
  );
  await ensureColumn(
    db,
    "grants",
    "proof_public_key",
    "ALTER TABLE grants ADD COLUMN proof_public_key text"
  );
  await revokeLegacyHostedBearerGrants(db);
  await ensureColumn(db, "authorization_requests", "relay_protocol", "ALTER TABLE authorization_requests ADD COLUMN relay_protocol integer");
  await ensureColumn(db, "authorization_requests", "application_public_key", "ALTER TABLE authorization_requests ADD COLUMN application_public_key text");
  await ensureColumn(db, "authorization_requests", "collection_hint", "ALTER TABLE authorization_requests ADD COLUMN collection_hint uuid");
  await ensureColumn(
    db,
    "authorization_requests",
    "flow",
    "ALTER TABLE authorization_requests ADD COLUMN flow text NOT NULL DEFAULT 'authorization_code'"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "device_code_hash",
    "ALTER TABLE authorization_requests ADD COLUMN device_code_hash text"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "user_code",
    "ALTER TABLE authorization_requests ADD COLUMN user_code text"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "user_code_hash",
    "ALTER TABLE authorization_requests ADD COLUMN user_code_hash text"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "poll_interval_seconds",
    "ALTER TABLE authorization_requests ADD COLUMN poll_interval_seconds integer NOT NULL DEFAULT 5"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "last_polled_at",
    "ALTER TABLE authorization_requests ADD COLUMN last_polled_at timestamptz"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "activation_started_at",
    "ALTER TABLE authorization_requests ADD COLUMN activation_started_at timestamptz"
  );
  await ensureColumn(
    db,
    "authorization_requests",
    "device_consumed_at",
    "ALTER TABLE authorization_requests ADD COLUMN device_consumed_at timestamptz"
  );
  await ensureNullable(db, "authorization_requests", "user_id");
  await ensureNullable(db, "authorization_requests", "redirect_uri");
  await ensureNullable(db, "authorization_requests", "code_challenge");
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS authorization_requests_device_code_idx ON authorization_requests(device_code_hash)"
  );
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS authorization_requests_user_code_idx ON authorization_requests(user_code_hash)"
  );
  await ensureColumn(db, "hosted_collections", "provider_url", "ALTER TABLE hosted_collections ADD COLUMN provider_url text");
  await ensureColumn(
    db,
    "hosted_collections",
    "contracts",
    "ALTER TABLE hosted_collections ADD COLUMN contracts jsonb NOT NULL DEFAULT '[]'::jsonb"
  );
  await ensureColumn(
    db,
    "hosted_collections",
    "authority_state",
    "ALTER TABLE hosted_collections ADD COLUMN authority_state text NOT NULL DEFAULT 'active'"
  );
  await ensureColumn(
    db,
    "hosted_collections",
    "authority_epoch",
    "ALTER TABLE hosted_collections ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 1"
  );
  await ensureColumn(
    db,
    "hosted_collections",
    "transferred_collection_id",
    "ALTER TABLE hosted_collections ADD COLUMN transferred_collection_id uuid"
  );
  await ensureColumn(
    db,
    "external_identities",
    "email_verified",
    "ALTER TABLE external_identities ADD COLUMN email_verified boolean NOT NULL DEFAULT false"
  );
  await ensureColumn(db, "external_identities", "avatar_url", "ALTER TABLE external_identities ADD COLUMN avatar_url text");
  await ensureColumn(db, "external_identities", "last_login_at", "ALTER TABLE external_identities ADD COLUMN last_login_at timestamptz");
  await ensureColumn(
    db,
    "sessions",
    "provider",
    "ALTER TABLE sessions ADD COLUMN provider text NOT NULL DEFAULT 'session'"
  );
  await backfillSessionProviders(db);
  await ensureColumn(
    db,
    "grants",
    "hosted_collection_id",
    "ALTER TABLE grants ADD COLUMN hosted_collection_id uuid"
  );
  await ensureColumn(db, "grants", "hosted_replica_id", "ALTER TABLE grants ADD COLUMN hosted_replica_id uuid");
  await ensureColumn(
    db,
    "hosted_replicas",
    "purpose",
    "ALTER TABLE hosted_replicas ADD COLUMN purpose text NOT NULL DEFAULT 'mirror'"
  );
  await ensureColumn(
    db,
    "push_channels",
    "kind",
    "ALTER TABLE push_channels ADD COLUMN kind text NOT NULL DEFAULT 'web_push'"
  );
  await ensureColumn(
    db,
    "push_channels",
    "fcm_project_id",
    "ALTER TABLE push_channels ADD COLUMN fcm_project_id text"
  );
  await ensureColumn(
    db,
    "push_channels",
    "fcm_token",
    "ALTER TABLE push_channels ADD COLUMN fcm_token text"
  );
  await ensureColumn(
    db,
    "push_channels",
    "fcm_token_hash",
    "ALTER TABLE push_channels ADD COLUMN fcm_token_hash text"
  );
  await ensureColumn(
    db,
    "push_channels",
    "last_seen_at",
    "ALTER TABLE push_channels ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now()"
  );
  await ensureNullable(db, "push_channels", "endpoint");
  await ensureNullable(db, "push_channels", "endpoint_hash");
  await ensureNullable(db, "push_channels", "p256dh");
  await ensureNullable(db, "push_channels", "auth");
  await db.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS push_channels_fcm_target_idx ON push_channels(grant_id, fcm_token_hash)"
  );
  const grantCollection = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'grants' AND column_name = 'collection_id'`
  );
  if (grantCollection.rows[0]?.is_nullable === "NO") {
    await db.query("ALTER TABLE grants ALTER COLUMN collection_id DROP NOT NULL");
  }
  const hostedReplicaToken = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'hosted_replicas' AND column_name = 'token_hash'`
  );
  if (hostedReplicaToken.rows[0]?.is_nullable === "NO") {
    await db.query("ALTER TABLE hosted_replicas ALTER COLUMN token_hash DROP NOT NULL");
  }
  await ensureNullable(db, "users", "email");
  await ensureNullable(db, "external_identities", "login");
  await ensureConstraint(
    db,
    "grants",
    "grants_hosted_collection_id_fkey",
    `ALTER TABLE grants ADD CONSTRAINT grants_hosted_collection_id_fkey
     FOREIGN KEY (hosted_collection_id) REFERENCES hosted_collections(id) ON DELETE CASCADE`
  );
  await ensureConstraint(
    db,
    "grants",
    "grants_hosted_replica_id_fkey",
    `ALTER TABLE grants ADD CONSTRAINT grants_hosted_replica_id_fkey
     FOREIGN KEY (hosted_replica_id) REFERENCES hosted_replicas(id) ON DELETE SET NULL`
  );
  await ensureConstraint(
    db,
    "grants",
    "grants_collection_target_check",
    `ALTER TABLE grants ADD CONSTRAINT grants_collection_target_check
     CHECK ((collection_id IS NULL) <> (hosted_collection_id IS NULL))`
  );
  await ensureConstraint(
    db,
    "hosted_collections",
    "hosted_collections_transferred_collection_id_fkey",
    `ALTER TABLE hosted_collections ADD CONSTRAINT hosted_collections_transferred_collection_id_fkey
     FOREIGN KEY (transferred_collection_id) REFERENCES collections(id) ON DELETE SET NULL`
  );
  await ensureConstraint(
    db,
    "collections",
    "collections_authority_state_check",
    `ALTER TABLE collections ADD CONSTRAINT collections_authority_state_check
     CHECK (authority_state IN ('active', 'candidate', 'retired'))`
  );
  await ensureConstraint(
    db,
    "hosted_collections",
    "hosted_collections_authority_state_check",
    `ALTER TABLE hosted_collections ADD CONSTRAINT hosted_collections_authority_state_check
     CHECK (authority_state IN ('active', 'transferring', 'transferred'))`
  );
  const activeAuthorities = await db.query<{
    id: string;
    user_id: string;
    local_id: string;
  }>(
    `SELECT id, user_id, local_id FROM collections
     WHERE authority_state = 'active'
     ORDER BY last_seen_at DESC, id`
  );
  const retainedAuthorities = new Set<string>();
  for (const authority of activeAuthorities.rows) {
    const identity = `${authority.user_id}:${authority.local_id}`;
    if (retainedAuthorities.has(identity)) {
      await db.query(
        `UPDATE collections SET authority_state = 'candidate', enabled = false
         WHERE id = $1`,
        [authority.id]
      );
    } else {
      retainedAuthorities.add(identity);
    }
  }
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS collections_active_authority_idx
     ON collections(user_id, local_id) WHERE authority_state = 'active'`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS authorization_collection_offers_lookup_idx
     ON authorization_collection_offers(authorization_id, expires_at)`
  );
}

export async function backfillSessionProviders(db: DatabaseQueryable): Promise<void> {
  await db.query(
    `UPDATE sessions SET provider = 'github'
     FROM external_identities
     WHERE sessions.provider = 'session'
       AND external_identities.user_id = sessions.user_id
       AND external_identities.provider = 'github'`
  );
}

export async function revokeLegacyHostedBearerGrants(db: DatabaseQueryable): Promise<void> {
  await db.query(
    `UPDATE grants
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE hosted_collection_id IS NOT NULL
       AND application_origin = 'null'
       AND proof_public_key IS NULL`
  );
  await db.query(
    `UPDATE access_tokens
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE grant_id IN (
       SELECT id FROM grants
       WHERE hosted_collection_id IS NOT NULL
         AND application_origin = 'null'
         AND proof_public_key IS NULL
     )`
  );
  await db.query(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE grant_id IN (
       SELECT id FROM grants
       WHERE hosted_collection_id IS NOT NULL
         AND application_origin = 'null'
         AND proof_public_key IS NULL
     )`
  );
}

async function ensureNullable(db: DatabaseQueryable, table: string, column: string): Promise<void> {
  const result = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (result.rows[0]?.is_nullable === "NO") {
    await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
  }
}

async function ensureNotNullable(
  db: DatabaseQueryable,
  table: string,
  column: string
): Promise<void> {
  const result = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (result.rows[0]?.is_nullable === "YES") {
    await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
  }
}

async function ensureColumn(
  db: DatabaseQueryable,
  table: string,
  column: string,
  statement: string
): Promise<void> {
  const result = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (!result.rows[0]) await db.query(statement);
}

async function ensureConstraint(
  db: DatabaseQueryable,
  table: string,
  constraint: string,
  statement: string
): Promise<void> {
  const result = await db.query<{ constraint_name: string }>(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_name = $1 AND constraint_name = $2`,
    [table, constraint]
  );
  if (!result.rows[0]) await db.query(statement);
}
