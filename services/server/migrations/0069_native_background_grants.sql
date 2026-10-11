-- One background authority identity for the existing timer/receipt/channel engine.
-- Legacy identities reference REAL grants, retaining their original IDs. Native
-- identities are explicit installation/collection timer consent, never OAuth rows.
-- Approval references survive transient pairing-window pruning, like credentials.
ALTER TABLE installation_device_pairings ADD COLUMN timer_declaration jsonb;
ALTER TABLE installation_device_pairings ADD COLUMN timer_consent boolean;
ALTER TABLE installation_device_pairings ADD CONSTRAINT installation_timer_declaration_shape
  CHECK (timer_declaration IS NULL OR jsonb_typeof(timer_declaration) = 'object');
ALTER TABLE installation_device_pairings ADD CONSTRAINT installation_timer_consent_snapshot
  CHECK (timer_consent IS NULL OR timer_consent = false OR timer_declaration IS NOT NULL);

ALTER TABLE installation_device_credentials ADD CONSTRAINT installation_timer_enrollment_identity
  UNIQUE (connector_id, installation_id, device_id, kind, sign_pk, kem_pk, noise_pk);

CREATE TABLE next_background_grants (
  id uuid PRIMARY KEY,
  principal_kind text NOT NULL CHECK (principal_kind IN ('legacy', 'installation')),
  legacy_grant_id uuid UNIQUE REFERENCES grants(id) ON DELETE CASCADE,
  native_connector_id uuid,
  installation_id uuid,
  device_id uuid,
  device_kind text,
  sign_pk bytea,
  kem_pk bytea,
  noise_pk bytea,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
  collection_id uuid REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  approval_request_id uuid,
  timer_declaration jsonb,
  approved_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (native_connector_id, installation_id, device_id, device_kind, sign_pk, kem_pk, noise_pk)
    REFERENCES installation_device_credentials(connector_id, installation_id, device_id, kind, sign_pk, kem_pk, noise_pk)
    ON DELETE CASCADE,
  CHECK (((principal_kind = 'legacy' AND id = legacy_grant_id
      AND native_connector_id IS NULL AND installation_id IS NULL AND device_id IS NULL
      AND device_kind IS NULL AND sign_pk IS NULL AND kem_pk IS NULL AND noise_pk IS NULL
      AND user_id IS NULL AND application_id IS NULL AND collection_id IS NULL
      AND approval_request_id IS NULL AND timer_declaration IS NULL
      AND approved_at IS NULL AND revoked_at IS NULL)
    OR (principal_kind = 'installation' AND legacy_grant_id IS NULL
      AND native_connector_id IS NOT NULL AND installation_id IS NOT NULL AND device_id IS NOT NULL
      AND device_kind IS NOT NULL AND sign_pk IS NOT NULL AND kem_pk IS NOT NULL AND noise_pk IS NOT NULL
      AND user_id IS NOT NULL AND application_id IS NOT NULL AND collection_id IS NOT NULL
      AND approval_request_id IS NOT NULL AND timer_declaration IS NOT NULL
      AND jsonb_typeof(timer_declaration) = 'object' AND approved_at IS NOT NULL)) IS TRUE)
);
CREATE INDEX next_background_native_scope
  ON next_background_grants(native_connector_id, collection_id);
CREATE UNIQUE INDEX next_background_native_live
  ON next_background_grants(native_connector_id, collection_id)
  WHERE principal_kind = 'installation' AND revoked_at IS NULL;
CREATE UNIQUE INDEX next_background_native_original_approval
  ON next_background_grants(approval_request_id, collection_id)
  WHERE principal_kind = 'installation';

CREATE INDEX next_background_native_collection
  ON next_background_grants(collection_id) WHERE principal_kind = 'installation';
CREATE INDEX next_background_native_user
  ON next_background_grants(user_id) WHERE principal_kind = 'installation';
CREATE INDEX next_background_native_application
  ON next_background_grants(application_id) WHERE principal_kind = 'installation';

-- mdbase:native-background-grant-hooks:v1
-- Real PostgreSQL alone qualifies FK upgrades, raw inserts/cascades and hooks.
-- The schema-only memory adapter must not emulate native grant authority.
-- Exclude grant writers until both the backfill and insert hook are committed.
LOCK TABLE grants IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO next_background_grants(id, principal_kind, legacy_grant_id)
  SELECT id, 'legacy', id FROM grants;

CREATE FUNCTION installation_timer_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.timer_declaration IS DISTINCT FROM NEW.timer_declaration
     OR (OLD.timer_consent IS NOT NULL AND OLD.timer_consent IS DISTINCT FROM NEW.timer_consent)
     OR (OLD.timer_consent IS NULL AND NEW.timer_consent IS NOT NULL AND EXISTS (
       SELECT 1 FROM pairing_requests p WHERE p.id=OLD.pairing_id
         AND (p.approved_at IS NOT NULL OR p.consumed_at IS NOT NULL OR p.revoked_at IS NOT NULL))) THEN
    RAISE EXCEPTION 'Original installation timer declaration and consent are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER installation_timer_request_immutable
  BEFORE UPDATE OF timer_declaration,timer_consent ON installation_device_pairings FOR EACH ROW
  EXECUTE FUNCTION installation_timer_request_immutable();

CREATE FUNCTION next_background_legacy_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO next_background_grants(id, principal_kind, legacy_grant_id)
    VALUES (NEW.id, 'legacy', NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER next_background_legacy_identity
  AFTER INSERT ON grants FOR EACH ROW EXECUTE FUNCTION next_background_legacy_identity();

-- Preserve all original IDs and backing data. Discover the actual predecessor
-- FK name instead of assuming a historical deployment's constraint spelling.
DO $$
DECLARE child text; old_constraint text; matches integer;
BEGIN
  FOREACH child IN ARRAY ARRAY['next_timers', 'next_timer_events', 'next_timer_namespace_intents',
      'push_channels', 'notification_subscriptions', 'notification_signals'] LOOP
    SELECT min(c.conname::text), count(*) INTO old_constraint, matches
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid
      WHERE c.contype='f' AND c.conrelid=child::regclass AND c.confrelid='grants'::regclass
        AND a.attname='grant_id' AND c.conkey=ARRAY[a.attnum]::smallint[];
    IF matches <> 1 THEN RAISE EXCEPTION 'Expected one original background grant foreign key in %', child; END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', child, old_constraint);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(grant_id) REFERENCES next_background_grants(id) ON DELETE CASCADE NOT VALID',
      child, child || '_background_grant_fkey');
  END LOOP;
END $$;

CREATE FUNCTION next_background_native_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.principal_kind <> 'installation'
     OR to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at'
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'Background grant identity and consent are immutable; revocation is permanent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER next_background_native_immutable
  BEFORE UPDATE ON next_background_grants FOR EACH ROW EXECUTE FUNCTION next_background_native_immutable();

CREATE FUNCTION next_background_connector_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE next_background_grants SET revoked_at=clock_timestamp()
    WHERE principal_kind='installation' AND native_connector_id=NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER next_background_connector_revoked
  AFTER UPDATE OF revoked_at ON connectors FOR EACH ROW
  WHEN (NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION next_background_connector_revoked();

CREATE FUNCTION next_background_scope_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE next_background_grants SET revoked_at=clock_timestamp()
    WHERE principal_kind='installation' AND native_connector_id=OLD.connector_id
      AND collection_id=OLD.collection_id AND revoked_at IS NULL;
  RETURN OLD;
END $$;
CREATE TRIGGER next_background_scope_removed
  AFTER DELETE ON installation_collection_scopes FOR EACH ROW
  EXECUTE FUNCTION next_background_scope_removed();
