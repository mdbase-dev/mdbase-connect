-- Caller-retained operation identities for timer intent recovery, not delivery
-- receipts. All mutations of a namespace must share its existing transaction
-- lock and advance intent_revision; operation replay never re-applies an intent.
CREATE TABLE next_timer_namespace_intents (
  grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  namespace text NOT NULL CHECK (namespace ~ '^[A-Za-z0-9._-]{1,64}$'),
  intent_revision bigint NOT NULL DEFAULT 0
    CHECK (intent_revision >= 0 AND intent_revision <= 9007199254740991),
  PRIMARY KEY (grant_id, namespace)
);

-- No request bodies or timer data are copied here. The result contains only
-- bounded original mutation metadata; application/provider delivery is separate.
-- Receipts have a seven-day recovery horizon. New admission requires a UUIDv7
-- within five minutes of server time; expired missing identities never execute.
-- Namespace revisions are never pruned/reset. Lookup does not perform cleanup.
CREATE TABLE next_timer_operation_receipts (
  grant_id uuid NOT NULL,
  operation_id uuid NOT NULL
    CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  namespace text NOT NULL,
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  terms_digest bytea NOT NULL CHECK (octet_length(terms_digest) = 32),
  expected_revision bigint NOT NULL
    CHECK (expected_revision >= 0 AND expected_revision < 9007199254740991),
  committed_revision bigint NOT NULL
    CHECK (committed_revision = expected_revision + 1),
  result_metadata jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, operation_id),
  FOREIGN KEY (grant_id, namespace)
    REFERENCES next_timer_namespace_intents(grant_id, namespace) ON DELETE CASCADE
);
