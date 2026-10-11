-- Optional file actions an installation asks for when the person first needs
-- them (for example, adding an image). A request names one collection already in
-- the installation's scope, the declared optional actions and a one-line reason
-- shown on the approval page. The approval records the person's decision for that
-- app on that collection; the SDK honours it. It does not narrow the installation
-- device's collection keys.
ALTER TABLE installation_device_pairings
  ADD COLUMN file_access_collection_id uuid,
  ADD COLUMN requested_file_actions text[],
  ADD COLUMN file_access_reason text,
  ADD COLUMN approved_file_actions text[];

-- IS TRUE keeps a NULL comparison from passing a malformed row.
ALTER TABLE installation_device_pairings
  ADD CONSTRAINT installation_file_access_shape CHECK ((
    (file_access_collection_id IS NULL AND requested_file_actions IS NULL
      AND file_access_reason IS NULL AND approved_file_actions IS NULL)
    OR (file_access_collection_id IS NOT NULL AND scope_only AND NOT requested_create_collections
      AND cardinality(requested_file_actions) BETWEEN 1 AND 6
      AND array_position(requested_file_actions, NULL) IS NULL
      AND requested_file_actions <@ ARRAY['list','read','add','replace','move','delete']::text[]
      AND char_length(file_access_reason) BETWEEN 1 AND 140
      AND (approved_file_actions IS NULL OR (
        array_position(approved_file_actions, NULL) IS NULL
        AND approved_file_actions <@ requested_file_actions)))
  ) IS TRUE);

-- The approved optional file actions per installation and collection. Removing
-- the collection from the installation's scope removes them with the row.
ALTER TABLE installation_collection_scopes
  ADD COLUMN file_actions text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT installation_scope_file_actions CHECK ((
    array_position(file_actions, NULL) IS NULL
    AND file_actions <@ ARRAY['list','read','add','replace','move','delete']::text[]
  ) IS TRUE);
