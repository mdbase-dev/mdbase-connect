# 2026-10-08 appserver — scoped installation consent

C5 adds explicitly requested create capability, approved cloud-copy UUIDs, additive same-device re-consent and separate explicit per-collection removal. It scopes installation list/join/log-token/people, allows current approved non-owner members to join, and leaves ordinary daemons/application grants unchanged.

Exact request/receipt/digest/currentness/removal semantics: [`docs/installation-collection-scope.md`](../../installation-collection-scope.md).

Consumers: clients/TaskNotes first-run and settings, Connect portal/Editor access controls, hostedw native policy revocation. Original connector/device/sign/KEM/Noise keys and bearer are retained; metadata is never readiness. No production activation.

PR: mdbase-dev/mdbase-connect#659.
