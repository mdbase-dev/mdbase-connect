-- Per-invitation fixture selection; normal invitations retain deployment policy.
-- Runtime admission additionally requires environment=lab and [test] marking.
ALTER TABLE invitations ADD COLUMN account_backend text;
ALTER TABLE invitations ADD CONSTRAINT invitations_lab_fixture_backend_check
  CHECK (account_backend IS NULL OR
    (account_backend = 'legacy' AND normalized_email LIKE '%@lab.invalid'));
