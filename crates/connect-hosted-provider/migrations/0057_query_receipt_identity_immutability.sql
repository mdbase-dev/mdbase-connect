-- Replica and collection identity are part of every receipt usage-counter key.
-- Account binding is intentionally mutable during legacy quota reconciliation,
-- and its existing trigger moves the account counter transactionally. Replica
-- and collection rebinding has no legitimate application path, so reject it
-- rather than allowing counters to diverge from receipt ownership.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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

CREATE TRIGGER hosted_provider_query_receipt_identity_immutability
BEFORE UPDATE OF replica_id, collection_id
ON hosted_provider_query_page_receipts
FOR EACH ROW EXECUTE FUNCTION hosted_provider_reject_query_receipt_identity_update();
