-- Account cutover is explicit; enabling NEXT globally never migrates an account.
-- Only the guarded migration/cutover owner changes this marker after takeover.
ALTER TABLE users ADD COLUMN account_backend text NOT NULL DEFAULT 'legacy'
  CHECK (account_backend IN ('legacy', 'next'));
