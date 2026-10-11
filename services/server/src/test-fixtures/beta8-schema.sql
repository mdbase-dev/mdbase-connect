-- Original initial schema from v0.1.0-beta.8:services/server/src/db.ts.
-- Account/session upgrade fixture, not native authority/locking qualification.

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
        CHECK (authority_state IN ('importing', 'active', 'transferring', 'transferred')),
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
      pairing_id uuid REFERENCES mirror_pairing_requests(id) ON DELETE CASCADE,
      replica_id uuid REFERENCES hosted_replicas(id) ON DELETE CASCADE,
      local_collection_id uuid REFERENCES collections(id) ON DELETE SET NULL,
      direction text NOT NULL DEFAULT 'to_local'
        CHECK (direction IN ('to_local', 'to_hosted')),
      state text NOT NULL DEFAULT 'requested'
        CHECK (state IN ('requested', 'approved', 'prepared', 'activating', 'completed', 'cancelled', 'expired')),
      final_head bigint,
      next_authority_epoch bigint,
      manifest_digest text,
      source_revision text,
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
