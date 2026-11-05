## Fixed

- Private and other native grant revocations remain `revoking` until their log
  revocation is durably appended. Migrated log-bound grants no longer complete
  early on a connector feed acknowledgement. No protocol or schema changes.
