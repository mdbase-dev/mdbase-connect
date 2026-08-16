-- Receipt usage counters bind the ciphertext footprint at insertion time.
-- Payloads are replay artifacts, not mutable rows: enforcing that invariant in
-- PostgreSQL prevents a future maintenance path from changing bytes without
-- applying the corresponding usage deltas.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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

CREATE TRIGGER hosted_provider_query_receipt_payload_immutability
BEFORE UPDATE OF response_ciphertext ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_reject_query_receipt_payload_update();
