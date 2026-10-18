# Installation sign-in requires the next backend

Account selection, key attestation, approval and exchange require the consenting
account's persisted `account_backend` to be `next`. Legacy accounts receive HTTP
409 `installation_legacy_backend` with `details.upgrade` saying where the
account's upgrade stands, and a plain message for it:

| `upgrade` | When | Portal |
| --- | --- | --- |
| `in_progress` | its migration has started | "being upgraded"; the window stays open and **Try again** retries it |
| `postponed` | its migration started, but a hosted collection was rolled back and not fenced again | "upgrade was paused"; keep using the current apps; the window is cancelled |
| `scheduled` | it is in a cohort that has not started | "will be upgraded soon"; the window is cancelled |
| `not_scheduled` | otherwise | asks the person to email support@mdbase.dev; the window is cancelled |

`postponed` comes from the audited migration steps: for some current hosted
collection that has not cut over, the latest `next_migration.rollback` or
`next_migration.unfence` is newer than its latest `next_migration.fence`. The
start claim (`started_at`) is deliberately kept after a rollback, because an
operator restart, the native MayFence check and replayed rollback-receipt reads
all bind to it.

No device or
installation credential is issued. Preserve the original request and key; once
migration completes the same live request can proceed.

Backend state is rechecked even for a committed exchange replay, so rollback to
legacy never re-emits the installation credential. Account selection, approval
and exchange check under the existing account row lock. Ordinary daemon pairing
is unchanged. A user can still deny a pending installation request after rollback.

This gate does not revoke an already issued installation credential by itself;
existing next collection authentication and enrolment gates remain independent.
