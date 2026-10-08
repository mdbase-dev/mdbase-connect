# Installation sign-in requires the next backend

Account selection, key attestation, approval and exchange require the consenting
account's persisted `account_backend` to be `next`. Legacy accounts receive HTTP
409 `installation_legacy_backend` with a migration instruction. No device or
installation credential is issued. Preserve the original request and key; once
migration completes the same live request can proceed.

Backend state is rechecked even for a committed exchange replay, so rollback to
legacy never re-emits the installation credential. Account selection, approval
and exchange check under the existing account row lock. Ordinary daemon pairing
is unchanged. A user can still deny a pending installation request after rollback.

This gate does not revoke an already issued installation credential by itself;
existing next collection authentication and enrolment gates remain independent.
