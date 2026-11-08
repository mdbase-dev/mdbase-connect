## Fixed

- Private and other native grant revocations remain `revoking` until their log
  revocation is durably appended. Migrated log-bound grants no longer complete
  early on a connector feed acknowledgement. No protocol changes.
- Earlier native revocations keep their completed status: migration 0096 records
  confirmation for appended and unbound grants, so they do not return to `revoking`.
