-- Independent of collection/account cleanup: a cancelled transfer ID must never
-- be prepared again, even after all of its old import rows have disappeared.
CREATE TABLE hosted_provider_authority_import_cancellations (
  transfer_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Also fence older preparation writers during rollout. They do not know about
-- this table, but no import may be recreated after acknowledgement. Locking the
-- same identity closes the SELECT-absence / late-INSERT race across transactions.
CREATE FUNCTION reject_cancelled_authority_import() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('mdbase-authority-import:' || NEW.id::text, 0));
  IF EXISTS (SELECT 1 FROM hosted_provider_authority_import_cancellations WHERE transfer_id = NEW.id) THEN
    RAISE EXCEPTION 'Authority import has been durably cancelled' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reject_cancelled_authority_import
BEFORE INSERT ON hosted_provider_authority_imports
FOR EACH ROW EXECUTE FUNCTION reject_cancelled_authority_import();
