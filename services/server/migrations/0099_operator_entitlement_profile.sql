-- An internal plan for the mdbase operator's own account, granted only by
-- `auth-admin entitlements grant`. Effective entitlements are the per-field
-- maximum across grants, so it raises storage (50 GiB), synced collections (100)
-- and single-file size (1 GiB) and keeps the beta plan's other limits.
-- Grants go only to accounts on the next backend: the legacy hosted provider
-- refuses storage above its 1 GiB per-collection cap.
INSERT INTO entitlement_profiles
  (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
   max_single_file_bytes, max_mirror_replicas_per_collection,
   max_application_replicas_per_collection, max_hosted_collections,
   max_files_per_collection, max_collection_member_seats)
VALUES
  ('operator_v1', 53687091200, 107374182400, 2097152, 1073741824,
   10, 50, 100, 10000, 10);
