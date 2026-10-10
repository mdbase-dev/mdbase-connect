-- No-email confirmation is a new request-local proof, not a historical backfill.
ALTER TABLE installation_device_pairings
  ADD COLUMN portal_account_provider text,
  ADD COLUMN portal_account_login text,
  DROP CONSTRAINT installation_portal_confirmation_complete,
  ADD CONSTRAINT installation_portal_confirmation_complete CHECK (
    (portal_account_confirmed_at IS NULL AND portal_account_email IS NULL
      AND portal_account_provider IS NULL AND portal_account_login IS NULL
      AND portal_account_session_id IS NULL AND portal_account_session_epoch IS NULL)
    OR (portal_account_confirmed_at IS NOT NULL
      AND portal_account_session_id IS NOT NULL AND portal_account_session_epoch IS NOT NULL
      AND ((portal_account_email IS NOT NULL AND portal_account_provider IS NULL AND portal_account_login IS NULL)
        OR (portal_account_email IS NULL AND portal_account_provider IS NOT NULL
          AND portal_account_provider='github' AND portal_account_login IS NOT NULL
          AND octet_length(portal_account_login) BETWEEN 1 AND 100)))
  );
