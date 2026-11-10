-- Device access to Private collections for an application's own
-- installation (docs/installation-private-device.md). Existing rows acquire
-- nothing: every scope stays a cloud-copy scope and no pairing asked for this.
--
-- A scope row with private_device = true is the person's explicit consent for
-- this installation to be a keyed device of that collection while it is
-- sync = 'private'. It is never cloud-copy consent, and a cloud-copy row
-- (private_device = false) is never Private device consent.
ALTER TABLE installation_collection_scopes
  ADD COLUMN private_device boolean NOT NULL DEFAULT false;

-- The original request's ask (immutable, like requested_create_collections)
-- and the portal's explicit per-collection decision, recorded at approval and
-- written to the scope at credential exchange with the cloud-copy scope.
ALTER TABLE installation_device_pairings
  ADD COLUMN requested_private_device boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_private_device_collection_ids uuid[] NOT NULL DEFAULT '{}';

-- mdbase:installation-private-device-shape:v1
-- IS TRUE keeps a NULL comparison from passing a malformed row.
ALTER TABLE installation_device_pairings
  ADD CONSTRAINT installation_private_device_shape CHECK ((
    array_position(approved_private_device_collection_ids, NULL) IS NULL
    AND NOT (approved_private_device_collection_ids && approved_collection_ids)
    AND CASE WHEN requested_private_device
      THEN kind = 'app-runtime' AND recovery_collection_id IS NULL AND file_access_collection_id IS NULL
      ELSE approved_private_device_collection_ids = '{}'::uuid[] END
  ) IS TRUE);
