-- Receipt admission must not detoast and sum the complete encrypted receipt
-- population for every page. This migration is intentionally quiescent: page
-- receipts live for only five minutes, so rollout drains them before adding
-- transactionally maintained footprint counters.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Every query transaction holds the shared side from admission through page
-- receipt commit. Taking the exclusive side makes the drain check and trigger
-- installation atomic with respect to both in-flight and new receipts.
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM hosted_provider_query_page_receipts LIMIT 1) THEN
    RAISE EXCEPTION
      '0049 requires hosted_provider_query_page_receipts to be drained';
  END IF;
END
$$;

ALTER TABLE hosted_provider_query_page_receipts
  ADD COLUMN account_id uuid,
  ADD COLUMN response_ciphertext_bytes bigint
    GENERATED ALWAYS AS (octet_length(response_ciphertext)::bigint) STORED;

ALTER TABLE hosted_provider_query_page_receipts
  ADD CONSTRAINT hosted_provider_query_receipt_ciphertext_bytes_check
  CHECK (response_ciphertext_bytes > 0);

CREATE TABLE hosted_provider_query_receipt_usage (
  scope_kind text NOT NULL CHECK (
    scope_kind IN ('replica', 'collection', 'account', 'global')
  ),
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

CREATE TRIGGER hosted_provider_query_receipt_account_binding
BEFORE INSERT ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_bind_query_receipt_account();

CREATE TRIGGER hosted_provider_query_receipt_usage_tracking
AFTER INSERT OR DELETE OR UPDATE OF account_id ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_track_query_receipt_usage();
