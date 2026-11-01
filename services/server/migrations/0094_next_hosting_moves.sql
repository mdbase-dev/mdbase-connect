-- Moving a migrated hosted collection off the migration Worker onto this control
-- plane's own hosted deployment. `moving` refuses every hosted caller (no log
-- token, socket or record read) while the fence window passes and the service
-- device's wrapped keys are re-wrapped under the destination KMS key; `moved`
-- routes to the default deployment. No row: ordinary routing. released_at: the
-- deployment being left answered its activation with a custody verdict (it
-- dropped its engine) since this `moving` began. The key hashes are SHA-256 of
-- the ARN's UTF-8 bytes. Written only by the migration-token routes.
CREATE TABLE next_hosting_moves (
  collection_id uuid PRIMARY KEY REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('moving', 'moved')),
  from_kms_key_arn_sha256 text NOT NULL,
  to_kms_key_arn_sha256 text NOT NULL,
  moving_at timestamptz NOT NULL DEFAULT now(),
  moved_at timestamptz,
  released_at timestamptz,
  CHECK (from_kms_key_arn_sha256 <> to_kms_key_arn_sha256),
  CHECK ((state = 'moved') = (moved_at IS NOT NULL))
);
