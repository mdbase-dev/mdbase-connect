-- Connect retains grant IDs; policy grant IDs are single-use even after revocation.
CREATE TABLE next_grant_bindings (
  grant_id uuid PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  log_grant_id uuid NOT NULL UNIQUE,
  terms_digest bytea NOT NULL CHECK (octet_length(terms_digest) = 32),
  active boolean NOT NULL DEFAULT true
);

-- mdbase:next-grant-revoke-trigger:v1
-- One database lifecycle hook covers raw SQL bulk paths, deletion and cascading
-- account cleanup, in the SAME transaction as the originating change. Approval
-- and narrowing use the typed builder; a trigger never synthesizes new authority.
CREATE FUNCTION next_revoke_grant_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding next_grant_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.revoked_at IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO binding FROM next_grant_bindings WHERE grant_id = OLD.id AND active FOR UPDATE;
  IF FOUND THEN
    INSERT INTO next_policy_outbox(collection_id, ops)
    VALUES(binding.collection_id, jsonb_build_object('version', 1, 'ops', jsonb_build_array(
      jsonb_build_object('op', 'grant-revoke', 'grant', binding.log_grant_id::text))));
    UPDATE next_grant_bindings SET active = false WHERE grant_id = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER next_grant_revoke_update BEFORE UPDATE OF revoked_at ON grants
  FOR EACH ROW EXECUTE FUNCTION next_revoke_grant_binding();
CREATE TRIGGER next_grant_revoke_delete BEFORE DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION next_revoke_grant_binding();
