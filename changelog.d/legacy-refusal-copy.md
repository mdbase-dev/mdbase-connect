## Changed

- An app sign-in refused because the account has not been upgraded yet now says
  where the upgrade stands, in plain words (`details.upgrade` on
  `installation_legacy_backend`). Mid-upgrade, the window stays open with
  **Try again**. Otherwise the window is cancelled, and an account with no
  upgrade scheduled is pointed to support@mdbase.dev.
