-- mdbase-next control plane: collections served by the new runtime, and the outbox
-- of signed policy items appended to their logs (mdbase-next docs/ship/control-plane.md
-- §2, §4). Rows exist only for synced collections: 'private' (end-to-end, blind log,
-- no hosted replica, no escrow) or 'cloud_copy' (hosted replica + escrow).
-- Collections on this device have no log and no row. New tables only: the previous
-- release never reads them, and nothing writes them unless MDBASE_NEXT_CONTROL_PLANE=1.
CREATE TABLE next_collections (
  collection_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime text NOT NULL CHECK (runtime IN ('shadow', 'next')),
  sync text NOT NULL CHECK (sync IN ('private', 'cloud_copy')),
  root_key_id bytea NOT NULL,
  last_issued_at bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Target of service devices' composite key: they may exist only for cloud_copy.
  UNIQUE (collection_id, sync)
);

-- One signed item, built from one or more outbox rows. Its bytes are stored before
-- they are sent, so an unknown outcome is retried with the same bytes.
CREATE TABLE next_policy_batches (
  id bigserial PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  prev bytea NOT NULL,
  item bytea NOT NULL,
  issued_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'appended', 'parked')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  appended_at timestamptz
);
CREATE INDEX next_policy_batches_open_idx
  ON next_policy_batches(collection_id) WHERE state <> 'appended';

CREATE TABLE next_policy_outbox (
  id bigserial PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  ops jsonb NOT NULL,
  batch_id bigint REFERENCES next_policy_batches(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX next_policy_outbox_pending_idx
  ON next_policy_outbox(collection_id, id) WHERE batch_id IS NULL;
