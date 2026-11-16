-- Accounts that operators mark as test accounts exercise production through the
-- real apps. The usage report leaves every row they own out of its figures.
ALTER TABLE users ADD COLUMN test_account boolean NOT NULL DEFAULT false;
