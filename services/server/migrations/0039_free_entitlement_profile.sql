-- The free plan of the mdbase-next pricing (mdbase-next
-- docs/collection-states-and-pricing.md §6): one synced collection, a provisional
-- 250 MB storage cap until hosted cost is measured, one member seat, files up to the
-- ~100 MB sync default. max_hosted_collections counts synced collections.
--
-- Inserting the profile changes nothing: no account holds it until an operator runs
-- `auth-admin entitlements backfill-free` at rollout. Effective entitlements are the
-- per-field maximum across grants, so beta accounts are unaffected by also holding it.
INSERT INTO entitlement_profiles
  (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
   max_single_file_bytes, max_mirror_replicas_per_collection,
   max_application_replicas_per_collection, max_hosted_collections,
   max_files_per_collection, max_collection_member_seats)
VALUES
  ('free_v1', 262144000, 524288000, 2097152, 104857600,
   10, 50, 1, 10000, 1);
