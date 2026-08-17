-- Final bounded query runtime for the production beta.69 cutover. All durable
-- cursor/receipt formats begin at their current versions; there are no
-- prototype cursor, proof, inline Base, or receipt compatibility shapes.

CREATE TABLE hosted_provider_base_query_invocations (
  invocation_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL
    REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  scope_epoch bigint NOT NULL CHECK (scope_epoch > 0),
  base_plan jsonb NOT NULL CHECK (
    jsonb_typeof(base_plan) = 'object' AND pg_column_size(base_plan) <= 524288
  ),
  base_context jsonb CHECK (
    base_context IS NULL OR (
      jsonb_typeof(base_context) = 'object'
      AND pg_column_size(base_context) <= 524288
    )
  ),
  base_operation_clock text NOT NULL
    CHECK (octet_length(base_operation_clock) <= 64),
  hard_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hosted_provider_base_query_invocations_expiry_idx
  ON hosted_provider_base_query_invocations (hard_expires_at, invocation_id);

CREATE INDEX hosted_provider_base_query_invocations_collection_expiry_idx
  ON hosted_provider_base_query_invocations (
    collection_id, hard_expires_at, invocation_id
  );

-- Projection history pins the logical head; no PostgreSQL transaction or MVCC
-- snapshot survives between page requests. Exact fallback may have no current
-- generation, but saved views always remain generation-bound.
CREATE TABLE hosted_provider_query_cursors (
  cursor_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL
    REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  scope_epoch bigint NOT NULL CHECK (scope_epoch > 0),
  request_kind text NOT NULL
    CHECK (request_kind IN ('query', 'canonical_view', 'obsidian_base')),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  snapshot_head bigint NOT NULL CHECK (snapshot_head >= 0),
  generation_id uuid,
  catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL
    CHECK (projection_format_version > 0),
  semantic_engine_version text NOT NULL,
  query_plan_version integer NOT NULL CHECK (query_plan_version > 0),
  query_digest bytea NOT NULL CHECK (octet_length(query_digest) = 32),
  query_plan jsonb NOT NULL CHECK (
    jsonb_typeof(query_plan) = 'object'
    AND pg_column_size(query_plan) <= 262144
  ),
  result_meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(result_meta) = 'object' AND pg_column_size(result_meta) <= 16384
  ),
  exact_context_ciphertext bytea CHECK (
    exact_context_ciphertext IS NULL
    OR octet_length(exact_context_ciphertext) <= 2200000
  ),
  base_invocation_id uuid
    REFERENCES hosted_provider_base_query_invocations(invocation_id),
  last_order_values jsonb CHECK (
    last_order_values IS NULL OR jsonb_typeof(last_order_values) = 'array'
  ),
  last_record_id uuid,
  emitted_rows bigint NOT NULL DEFAULT 0 CHECK (emitted_rows >= 0),
  execution_proof_version integer NOT NULL CHECK (execution_proof_version = 2),
  execution_proof_ciphertext bytea NOT NULL,
  execution_proof_bytes bigint NOT NULL CHECK (
    execution_proof_bytes > 0
    AND execution_proof_bytes <= 67108864
    AND execution_proof_bytes = octet_length(execution_proof_ciphertext)
  ),
  snapshot_record_count bigint NOT NULL CHECK (snapshot_record_count >= 0),
  scan_budget_records bigint NOT NULL CHECK (scan_budget_records > 0),
  scan_budget_ciphertext_bytes bigint NOT NULL
    CHECK (scan_budget_ciphertext_bytes > 0),
  projection_integrity_epoch bigint
    CHECK (projection_integrity_epoch IS NULL OR projection_integrity_epoch > 0),
  cursor_bytes bigint NOT NULL CHECK (
    cursor_bytes > 0 AND cursor_bytes <= 67108864
  ),
  expires_at timestamptz NOT NULL,
  hard_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (collection_id, generation_id)
    REFERENCES hosted_provider_projection_generations (collection_id, generation_id),
  CHECK (expires_at <= hard_expires_at),
  CHECK ((last_order_values IS NULL) = (last_record_id IS NULL)),
  CHECK (generation_id IS NOT NULL OR request_kind IN ('query', 'obsidian_base')),
  CHECK ((request_kind = 'obsidian_base') = (base_invocation_id IS NOT NULL))
);

CREATE INDEX hosted_provider_query_cursors_expiry_idx
  ON hosted_provider_query_cursors (expires_at, cursor_id);

CREATE INDEX hosted_provider_query_cursors_replica_idx
  ON hosted_provider_query_cursors (replica_id, collection_id, cursor_id);

CREATE TABLE hosted_provider_query_page_receipts (
  replica_id uuid NOT NULL
    REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  account_id uuid,
  scope_epoch bigint NOT NULL CHECK (scope_epoch >= 1),
  request_kind text NOT NULL
    CHECK (request_kind IN ('query', 'canonical_view', 'obsidian_base')),
  input_digest bytea NOT NULL CHECK (octet_length(input_digest) = 32),
  response_ciphertext bytea NOT NULL,
  response_ciphertext_bytes bigint
    GENERATED ALWAYS AS (octet_length(response_ciphertext)::bigint) STORED,
  response_encoding text NOT NULL
    CHECK (response_encoding IN ('json-v1', 'zstd-json-v1')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, request_id),
  CHECK (response_ciphertext_bytes > 0)
);

CREATE INDEX hosted_provider_query_page_receipts_expiry_idx
  ON hosted_provider_query_page_receipts (collection_id, expires_at);

CREATE INDEX hosted_provider_query_page_receipts_global_expiry_idx
  ON hosted_provider_query_page_receipts (
    expires_at, collection_id, replica_id, request_id
  );

CREATE TABLE hosted_provider_query_receipt_usage (
  scope_kind text NOT NULL
    CHECK (scope_kind IN ('replica', 'collection', 'account', 'global')),
  scope_id uuid NOT NULL,
  receipt_count bigint NOT NULL CHECK (receipt_count >= 0),
  ciphertext_bytes bigint NOT NULL CHECK (ciphertext_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind, scope_id),
  CHECK ((receipt_count = 0) = (ciphertext_bytes = 0))
);

CREATE FUNCTION hosted_provider_adjust_query_receipt_usage(
  target_kind text,
  target_id uuid,
  count_delta bigint,
  bytes_delta bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF count_delta > 0 AND bytes_delta > 0 THEN
    INSERT INTO hosted_provider_query_receipt_usage (
      scope_kind, scope_id, receipt_count, ciphertext_bytes
    ) VALUES (
      target_kind, target_id, count_delta, bytes_delta
    )
    ON CONFLICT (scope_kind, scope_id) DO UPDATE
    SET receipt_count =
          hosted_provider_query_receipt_usage.receipt_count + EXCLUDED.receipt_count,
        ciphertext_bytes =
          hosted_provider_query_receipt_usage.ciphertext_bytes + EXCLUDED.ciphertext_bytes,
        updated_at = now();
  ELSIF count_delta < 0 AND bytes_delta < 0 THEN
    UPDATE hosted_provider_query_receipt_usage
    SET receipt_count = receipt_count + count_delta,
        ciphertext_bytes = ciphertext_bytes + bytes_delta,
        updated_at = now()
    WHERE scope_kind = target_kind AND scope_id = target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'query receipt usage counter is missing for %.%',
        target_kind, target_id;
    END IF;
  ELSE
    RAISE EXCEPTION 'query receipt usage deltas must share a non-zero sign';
  END IF;

  DELETE FROM hosted_provider_query_receipt_usage
  WHERE scope_kind = target_kind AND scope_id = target_id
    AND receipt_count = 0 AND ciphertext_bytes = 0;
END
$$;

CREATE FUNCTION hosted_provider_bind_query_receipt_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT account_id INTO NEW.account_id
  FROM hosted_provider_collections
  WHERE id = NEW.collection_id;
  RETURN NEW;
END
$$;

CREATE FUNCTION hosted_provider_track_query_receipt_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt hosted_provider_query_page_receipts%ROWTYPE;
  direction bigint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.account_id IS NOT DISTINCT FROM NEW.account_id THEN
      RETURN NEW;
    END IF;
    IF OLD.account_id IS NOT NULL THEN
      PERFORM hosted_provider_adjust_query_receipt_usage(
        'account', OLD.account_id, -1, -OLD.response_ciphertext_bytes
      );
    END IF;
    IF NEW.account_id IS NOT NULL THEN
      PERFORM hosted_provider_adjust_query_receipt_usage(
        'account', NEW.account_id, 1, NEW.response_ciphertext_bytes
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    receipt := NEW;
    direction := 1;
  ELSE
    receipt := OLD;
    direction := -1;
  END IF;

  PERFORM hosted_provider_adjust_query_receipt_usage(
    'replica', receipt.replica_id, direction,
    direction * receipt.response_ciphertext_bytes
  );
  PERFORM hosted_provider_adjust_query_receipt_usage(
    'collection', receipt.collection_id, direction,
    direction * receipt.response_ciphertext_bytes
  );
  IF receipt.account_id IS NOT NULL THEN
    PERFORM hosted_provider_adjust_query_receipt_usage(
      'account', receipt.account_id, direction,
      direction * receipt.response_ciphertext_bytes
    );
  END IF;
  PERFORM hosted_provider_adjust_query_receipt_usage(
    'global', '00000000-0000-0000-0000-000000000000'::uuid, direction,
    direction * receipt.response_ciphertext_bytes
  );
  RETURN receipt;
END
$$;

CREATE FUNCTION hosted_provider_reject_query_receipt_payload_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.response_ciphertext IS DISTINCT FROM OLD.response_ciphertext THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'hosted query receipt response ciphertext is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION hosted_provider_reject_query_receipt_identity_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.replica_id IS DISTINCT FROM OLD.replica_id
     OR NEW.collection_id IS DISTINCT FROM OLD.collection_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'hosted query receipt replica and collection identities are immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER hosted_provider_query_receipt_account_binding
BEFORE INSERT ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_bind_query_receipt_account();

CREATE TRIGGER hosted_provider_query_receipt_usage_tracking
AFTER INSERT OR DELETE OR UPDATE OF account_id
ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_track_query_receipt_usage();

CREATE TRIGGER hosted_provider_query_receipt_payload_immutability
BEFORE UPDATE OF response_ciphertext ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_reject_query_receipt_payload_update();

CREATE TRIGGER hosted_provider_query_receipt_identity_immutability
BEFORE UPDATE OF replica_id, collection_id
ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_reject_query_receipt_identity_update();

-- Admission fencing closes rollback and maintenance races. Release requests
-- intentionally bypass the query-admission gate so clients can drain.
CREATE TABLE hosted_provider_runtime_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  query_admission_suspended boolean NOT NULL DEFAULT false,
  suspension_reason text CHECK (
    suspension_reason IS NULL OR length(suspension_reason) BETWEEN 1 AND 512
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (query_admission_suspended OR suspension_reason IS NULL)
);

INSERT INTO hosted_provider_runtime_control (singleton) VALUES (true);
