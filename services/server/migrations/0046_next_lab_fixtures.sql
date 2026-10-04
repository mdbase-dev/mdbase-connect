-- LAB-only disposable log ownership ledger. Retain tombstones so retries never
-- adopt an unrelated collection or recreate an already destroyed fixture.
CREATE TABLE next_lab_fixtures (
  fixture_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES connectors(id),
  device_id uuid NOT NULL REFERENCES next_devices(id),
  label text NOT NULL CHECK (label LIKE '[test] %'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  deleting_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX next_lab_fixtures_owner_idx ON next_lab_fixtures(owner_user_id) WHERE deleted_at IS NULL;
