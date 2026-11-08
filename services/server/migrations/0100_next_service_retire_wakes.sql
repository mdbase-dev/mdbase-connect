-- A hosted or escrow copy learns that it must retire (collection deleted, account
-- deleted, collection no longer a cloud copy) only when it next asks the control
-- plane. These rows make the control plane wake it at once through the existing
-- activation route; the copy still verifies the verdict with the control plane
-- before it erases anything, so a row is a wake request, never a verdict.
-- No foreign key: a row must outlive the cascade that removes its collection and
-- service devices (account deletion). The activation poller deletes it after a
-- definite answer and backs it off otherwise. `queued_at` fences an older
-- completion from clearing a wake queued again after it was sent.
CREATE TABLE next_service_retire_wakes (
  collection_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('hosted', 'escrow')),
  queued_at timestamptz NOT NULL DEFAULT now(),
  next_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9),
  PRIMARY KEY (collection_id, kind)
);
CREATE INDEX next_service_retire_wakes_due ON next_service_retire_wakes(next_at, collection_id, kind);

-- mdbase:next-service-retire-wake-trigger:v1
-- A service device stops existing when its collection leaves cloud copy (switch to
-- Private, its abandonment, a cancelled switch to cloud copy) or with its owner's
-- account (cascade). A deletion fact (collection deletion, account deletion,
-- registry floor) keeps the devices, so it queues their wakes itself.
CREATE OR REPLACE FUNCTION next_queue_service_retire_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'next_service_devices' THEN
    INSERT INTO next_service_retire_wakes(collection_id, kind) VALUES(OLD.collection_id, OLD.kind)
    ON CONFLICT (collection_id, kind) DO UPDATE SET queued_at = now(), next_at = now(), attempts = 0;
    RETURN OLD;
  END IF;
  INSERT INTO next_service_retire_wakes(collection_id, kind)
    SELECT collection_id, kind FROM next_service_devices WHERE collection_id = NEW.collection_id
  ON CONFLICT (collection_id, kind) DO UPDATE SET queued_at = now(), next_at = now(), attempts = 0;
  RETURN NEW;
END;
$$;

CREATE TRIGGER next_service_devices_retire_wake AFTER DELETE ON next_service_devices
  FOR EACH ROW EXECUTE FUNCTION next_queue_service_retire_wake();
CREATE TRIGGER next_collection_deletion_retire_wake AFTER INSERT ON next_collection_deletion_facts
  FOR EACH ROW EXECUTE FUNCTION next_queue_service_retire_wake();
