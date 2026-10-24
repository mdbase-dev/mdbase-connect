-- Keep original native/Connect-owner receipt bytes. NULL identifies actual
-- legacy v1 receipts, whose owner UUID also named their storage account.
ALTER TABLE hosted_provider_legacy_rollback_receipts
  ADD COLUMN provider_account_id uuid
  CHECK (provider_account_id IS NULL OR provider_account_id <> '00000000-0000-0000-0000-000000000000'::uuid);
