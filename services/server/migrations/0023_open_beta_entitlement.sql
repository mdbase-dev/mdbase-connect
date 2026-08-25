-- Preserve the original beta_v1 allowance for invited participants while
-- giving new public-signup accounts a smaller hosted-collection ceiling.
INSERT INTO entitlement_profiles
  (code, hosted_storage_bytes, retained_file_bytes, max_document_bytes,
   max_single_file_bytes, max_mirror_replicas_per_collection,
   max_application_replicas_per_collection, max_hosted_collections,
   max_files_per_collection)
VALUES
  ('open_beta_v1', 1073741824, 2147483648, 2097152, 262144000,
   10, 50, 3, 10000);
