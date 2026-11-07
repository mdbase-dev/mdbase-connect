-- The first-month storage trial every public signup holds next to its permanent
-- free_v1 grant (with ends_at 30 days after signup). It raises hosted storage to
-- 5 GiB and nothing else: every other limit is free_v1's, so when the grant ends
-- the per-field maximum falls back to free_v1. retained_file_bytes must be at
-- least hosted_storage_bytes, so it equals the trial's storage.
INSERT INTO entitlement_profiles
  (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
   max_single_file_bytes, max_mirror_replicas_per_collection,
   max_application_replicas_per_collection, max_hosted_collections,
   max_files_per_collection, max_collection_member_seats)
VALUES
  ('trial_v1', 5368709120, 5368709120, 2097152, 104857600,
   10, 50, 1, 10000, 1);
