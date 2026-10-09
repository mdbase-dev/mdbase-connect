-- Shared catalog labels, not identities, paths or authorization evidence.
-- Private collections without a previously cleartext label remain unnamed.
ALTER TABLE next_collections ADD COLUMN display_name text;

-- mdbase:next-display-name-backfill:v1
-- Preserve legacy text verbatim and only borrow a label from the actual owner.
-- Multiple local registrations retain the existing stable first-row ordering.
UPDATE next_collections n
SET display_name = backfill.display_name
FROM (
  SELECT source.collection_id,
         COALESCE(h.display_name, local_label.display_name,
                  CASE WHEN source.sync = 'cloud_copy' THEN 'New collection' END) AS display_name
  FROM next_collections source
  LEFT JOIN hosted_collections h
    ON h.id = source.collection_id AND h.user_id = source.owner_user_id
  LEFT JOIN (
    SELECT DISTINCT ON (user_id, local_id) user_id, local_id, display_name
    FROM collections WHERE removed_at IS NULL ORDER BY user_id, local_id, id
  ) local_label
    ON local_label.local_id = source.collection_id AND local_label.user_id = source.owner_user_id
) backfill
WHERE n.collection_id = backfill.collection_id;
