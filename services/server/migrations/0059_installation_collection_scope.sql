-- Existing installations acquire no implicit scope. Re-consent preserves their
-- registered actor and credential; pairing approval records the explicit decision.
ALTER TABLE installation_device_pairings
  ADD COLUMN requested_create_collections boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_create_collections boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_collection_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN scope_only boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_session_epoch bigint;
ALTER TABLE installation_device_credentials
  ADD COLUMN create_collections boolean NOT NULL DEFAULT false;
CREATE TABLE installation_collection_scopes (
  connector_id uuid NOT NULL REFERENCES installation_device_credentials(connector_id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  PRIMARY KEY (connector_id, collection_id)
);
