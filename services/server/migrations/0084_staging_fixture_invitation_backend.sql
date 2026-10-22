-- Extend the existing reserved-domain fixture constraint; no account/data rewrite.
-- Runtime admission still binds LAB to lab.invalid and staging to staging.invalid,
-- checks [test] marking at issue and redemption, and refuses production overrides.
ALTER TABLE invitations DROP CONSTRAINT invitations_lab_fixture_backend_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_lab_fixture_backend_check
  CHECK (account_backend IS NULL OR
    (account_backend = 'legacy' AND
      (normalized_email LIKE '%@lab.invalid' OR normalized_email LIKE '%@staging.invalid')));
