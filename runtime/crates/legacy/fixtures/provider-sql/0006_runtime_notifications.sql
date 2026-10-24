CREATE TABLE IF NOT EXISTS hosted_provider_notification_grants (
  grant_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  grant_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hosted_provider_notification_grants_collection_idx
  ON hosted_provider_notification_grants(collection_id);

-- This source outbox is committed with the authoritative mutation. Runtime
-- admission is idempotent, so a crash after admission but before processed_at
-- simply replays the same collection/sequence event.
CREATE TABLE IF NOT EXISTS hosted_provider_runtime_outbox (
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  leased_until timestamptz,
  last_error text,
  PRIMARY KEY(collection_id, sequence)
);

CREATE INDEX IF NOT EXISTS hosted_provider_runtime_outbox_ready_idx
  ON hosted_provider_runtime_outbox(processed_at, available_at, leased_until, collection_id, sequence)
  WHERE processed_at IS NULL;
