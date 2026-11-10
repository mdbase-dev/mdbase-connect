# Documentation map

Runtime (mdbase-next) contracts and notes live in [`runtime/docs/`](../runtime/docs/README.md).
Git history is the archive for finished phases, campaigns and superseded designs.

## Overview and architecture

- [architecture.md](architecture.md) — system architecture overview.
- [code-quality.md](code-quality.md) — internal architecture rules and quality gates.
- [maintainability.md](maintainability.md) — maintainability handbook.
- [architecture/application-registration-reconciliation.md](architecture/application-registration-reconciliation.md) — application identity, registration and grant reconciliation jobs.
- [architecture/work-before-connecting.md](architecture/work-before-connecting.md) — apps working on unsynced local data before connecting.

## Accounts, sign-in and identity

- [account-authentication.md](account-authentication.md) — account sign-in and sessions.
- [google-auth.md](google-auth.md) — Google authentication.
- [account-backend.md](account-backend.md) — the `legacy | next` account backend marker.
- [account-key-strict-witnesses.md](account-key-strict-witnesses.md) — strict account-key completion witnesses.
- [next-account-wire.md](next-account-wire.md) — negotiated next account identity.
- [next-people.md](next-people.md) — next people profiles.
- [portable-people.md](portable-people.md) — portable people and app-visible account identity.
- [staging-signup-ip-limit.md](staging-signup-ip-limit.md) — password-signup IP limit setting.

## Applications, installations and consent

- [application-installation-pairing.md](application-installation-pairing.md) — installation pairing and app registration.
- [installation-device-sign-in.md](installation-device-sign-in.md) — first-party installation device sign-in.
- [installation-collection-scope.md](installation-collection-scope.md) — per-collection installation consent.
- [installation-legacy-refusal.md](installation-legacy-refusal.md) — installation sign-in requires the next backend.
- [unified-private-signin.md](unified-private-signin.md) — one collection chooser for Private and cloud-copy collections.
- [next-joint-consent.md](next-joint-consent.md) — next application consent controls.
- [next-grant-policy.md](next-grant-policy.md) — next grants: policy identity and permissions.
- [next-native-token-completion.md](next-native-token-completion.md) — Private token completion metadata.
- [native-app-platform.md](native-app-platform.md) — native application platform declarations.
- [native-approval-delivery.md](native-approval-delivery.md) — pushing Private approvals to Native.
- [device-approval-peer-metadata.md](device-approval-peer-metadata.md) — signed device-approval candidate metadata.
- [portable-apps.md](portable-apps.md) — portable HTML applications.
- [chatgpt-plugin.md](chatgpt-plugin.md) — ChatGPT and Codex plugin.
- [mcp-gateway.md](mcp-gateway.md) — hosted MCP gateway.

## SDK

- [sdk-beta-public-surface.md](sdk-beta-public-surface.md) — beta SDK public surface.
- [sdk-outcomes.md](sdk-outcomes.md) — typed outcomes and recovery.
- [sdk-query-helpers.md](sdk-query-helpers.md) — client query helpers.
- [sdk-observe.md](sdk-observe.md) and [architecture/sdk-observe.md](architecture/sdk-observe.md) — live record queries.
- [sdk-change-events.md](sdk-change-events.md) — collection change events.
- [record-session.md](record-session.md) — record editing sessions.
- [reader-startup.md](reader-startup.md) — app startup readiness with compatible SDKs.
- [file-upload-attempt-policy.md](file-upload-attempt-policy.md) — upload retry policies.
- [connect-contract-compatibility.md](connect-contract-compatibility.md) — contract compatibility matrix.

## Collections, sync and files

- [next-collection-names.md](next-collection-names.md) — synced collection names and deletion.
- [native-management-discovery.md](native-management-discovery.md) — native collections in `/v1/me`.
- [portal-add-collection.md](portal-add-collection.md) — the portal's Add collection entry.
- [collection-sharing-policy.md](collection-sharing-policy.md) — sharing synced collections.
- [collection-mode-api.md](collection-mode-api.md) — collection mode requests and status.
- [collection-mode-execution.md](collection-mode-execution.md) — collection mode controller.
- [collection-mode-switch-trust.md](collection-mode-switch-trust.md) — Cloud copy to Private switch-set acceptance.
- [private-cloud-handover.md](private-cloud-handover.md) — Private to Cloud copy owner handover.
- [service-cloud-copy-bootstrap.md](service-cloud-copy-bootstrap.md) — service-created cloud copies.
- [next-policy-outbox.md](next-policy-outbox.md) — policy outbox verification.
- [next-hosted-route-discovery.md](next-hosted-route-discovery.md) — hosted Noise route discovery.
- [hosted-current-authority.md](hosted-current-authority.md) — hosted/escrow current authority reads.
- [hosted-original-genesis.md](hosted-original-genesis.md) — original-genesis service-device record.
- [permanent-collection-deletion-foundation.md](permanent-collection-deletion-foundation.md) — permanent deletion denial ledger.
- [deletion-registry-reconciliation.md](deletion-registry-reconciliation.md) — nil-registry deletion transport.
- [known-deletion-log-token-denial.md](known-deletion-log-token-denial.md) — deletion facts at log-token refresh.
- [unmigrated-local-collections.md](unmigrated-local-collections.md) — `collection_not_yet_migrated` responses.
- [files.md](files.md) — collection files.
- [local-write-recovery.md](local-write-recovery.md) — recovering retained local writes.
- [exact-recovery-and-health.md](exact-recovery-and-health.md) — recovery and readiness reporting.

## Notifications and timers

- [notifications.md](notifications.md) — runtime-backed notifications.
- [native-installation-timers.md](native-installation-timers.md) — native installation reminders.
- [timer-operation-recovery.md](timer-operation-recovery.md) — timer operation recovery.
- [shared-feedback.md](shared-feedback.md) — shared private feedback.

## Desktop, CLI and self-hosting

- [headless.md](headless.md) — headless installation.
- [desktop-updates.md](desktop-updates.md) — desktop update architecture.
- [windows-store.md](windows-store.md) — Microsoft Store distribution.
- [self-hosting.md](self-hosting.md) — production self-hosting.
- [instance-administration.md](instance-administration.md) — instance administration.
- [control-plane-migrations.md](control-plane-migrations.md) — control-plane database migrations.
- [usage-report.md](usage-report.md) — operator usage report.
- [beta-observability.md](beta-observability.md) — privacy-safe operational signals.
- [native-staging-build.md](native-staging-build.md) — staging daemon build.
- [local-rehearsal-build.md](local-rehearsal-build.md) — local-only server build.

## Releases and CI

- [ci-qualification.md](ci-qualification.md) — CI qualification and artifact promotion.
- [ci-flakes.md](ci-flakes.md) — flake policy.
- [continuous-desktop-release.md](continuous-desktop-release.md) — continuous desktop releases.
- [continuous-sdk-release.md](continuous-sdk-release.md) — continuous SDK publication.
- [sdk-publication.md](sdk-publication.md) — source-built SDK publication.
- [runtime-npm-publication.md](runtime-npm-publication.md) — runtime npm packages.
- [runtime-worker-publication.md](runtime-worker-publication.md) — runtime Worker publication.
- [next-trust-release.md](next-trust-release.md) and [next-trust-payload.md](next-trust-payload.md) — NEXT release trust.
- [release-contract.md](release-contract.md) — product release contract.
- [releasing.md](releasing.md) — release checklist and package verification.
- `macos-unsigned-preview.txt`, `windows-unsigned-preview.txt` — release-note text used by the desktop workflow.

## Testing and performance

- [testing-environment.md](testing-environment.md) — development and ecosystem testing.
- [functional-stress-testing.md](functional-stress-testing.md) — seeded functional stress runner.
- [adversarial-file-testing.md](adversarial-file-testing.md) — hosted file lifecycle interleavings.
- [performance.md](performance.md) — local performance profiling.
- [benchmarks/runtime-contention/report.md](benchmarks/runtime-contention/report.md) — runtime contention invariants and reproduction.

## Security

- [threat-model.md](threat-model.md) — threat model.
- [encryption.md](encryption.md) — encryption architecture.
- [security-audit-package.md](security-audit-package.md) — security review entry point.

## Product and interface design

- [product-design/core-flows.md](product-design/core-flows.md) — core product flows.
- [product-design/capture-recovery.md](product-design/capture-recovery.md) — stale source-capture recovery.
- [product-design/identity-system.md](product-design/identity-system.md) — identity system.
- [product-design/icon-motion-system.html](product-design/icon-motion-system.html) — icon motion system.
- [mdbase-logo-studies.html](mdbase-logo-studies.html) — logo studies behind the mark.
- [mdbase-configurations-v2.html](mdbase-configurations-v2.html) — "A first look at mdbase" introduction, synced into mdbase.dev.
- [ui-foundations.md](ui-foundations.md) — shared UI components.
- [translations-portal.md](translations-portal.md) and [translations-portal-desktop.md](translations-portal-desktop.md) — UI translation catalogues and checks.

## Decisions

- [decisions/](decisions/) — ADRs 0001 and 0003–0013 (0002 was superseded by 0004).

## Legacy stack

These describe the legacy Connect stack (`crates/connect-*`, legacy hosted
provider, mirrors) and the migration of its accounts to the runtime. They go
with that code.

- [legacy-retirement.md](legacy-retirement.md) — what can be deleted, in what order, and what each step waits on.
- [cli-daemon.md](cli-daemon.md) — legacy connector CLI and daemon.
- [sync.md](sync.md) — legacy hosted collections and sync.
- [hosted-provider.md](hosted-provider.md) — legacy hosted provider.
- [architecture/hosted-queryable-execution.md](architecture/hosted-queryable-execution.md) — hosted query execution.
- [architecture/hosted-typed-runtime-adoption.md](architecture/hosted-typed-runtime-adoption.md) — hosted typed outcomes.
- [architecture/local-filesystem-runtime-adoption.md](architecture/local-filesystem-runtime-adoption.md) — local authority typed outcomes.
- [hosted-execution-testing.md](hosted-execution-testing.md) — hosted execution fixtures.
- [benchmarks/hosted-storage-model/](benchmarks/hosted-storage-model/README.md) — storage-model benchmark, fixtures and contracts read by `scripts/hosted-storage-benchmark/`.
- [lossless-opaque-sync-acceptance.md](lossless-opaque-sync-acceptance.md) — lossless opaque-document sync.
- [registry-schema-support.md](registry-schema-support.md) — local registry schema and recovery.
- [managed-account-migration.md](managed-account-migration.md) — whole-account migration driver.
- [lab-migration-run.md](lab-migration-run.md) — `next-migration-lab` runs and route-back.
- [migration-routing.md](migration-routing.md) — routing migrated hosted collections.
- [migration-topology-freeze.md](migration-topology-freeze.md) — topology freeze.
- [migration-capture.md](migration-capture.md), [migration-prearchive.md](migration-prearchive.md), [migration-receiving.md](migration-receiving.md) — capture, prearchive and receiving routes.
- [migration-archive-prefixes.md](migration-archive-prefixes.md), [migration-archive-retention.md](migration-archive-retention.md) — archive locations and retention.
- [migration-scoped-archive.md](migration-scoped-archive.md), [migration-zero-hosted-archive.md](migration-zero-hosted-archive.md), [scoped-recovery-bytes.md](scoped-recovery-bytes.md) — archive recovery profiles.
- [lab-cohort-archive-acceptance.md](lab-cohort-archive-acceptance.md), [lab-fixture-migration-start.md](lab-fixture-migration-start.md) — LAB archive and fixture profiles.
- [lab-pitr-current-cp.md](lab-pitr-current-cp.md), [prekey-original-admission.md](prekey-original-admission.md) — LAB PITR adapter and admission source.
- [migration-source-witness.md](migration-source-witness.md), [hosted-migration-current-claim.md](hosted-migration-current-claim.md), [hosted-migration-role-read.md](hosted-migration-role-read.md) — migration claims and witnesses.
- [hosted-migration-provider.md](hosted-migration-provider.md), [hosted-migration-shadow-target.md](hosted-migration-shadow-target.md) — provider fronts and SHADOW target.
- [hosted-migration-rollback-recovery.md](hosted-migration-rollback-recovery.md), [hosted-rollback-receipts.md](hosted-rollback-receipts.md), [hosted-rollback-provider-client.md](hosted-rollback-provider-client.md) — rollback receipts and recovery.
- [local-rollback-bindings.md](local-rollback-bindings.md) — fenced local rollback bindings.
- [native-migration-record.md](native-migration-record.md) — native migration cutover metadata.
- [migration-invitation-continuity.md](migration-invitation-continuity.md), [postmigration-operation-guards.md](postmigration-operation-guards.md) — invitations and guards around migration.
- [archive-erasure-admin.md](archive-erasure-admin.md) — pre-freeze deletion drain.
- [legacy-notification-migration-fence.md](legacy-notification-migration-fence.md), [hosted-timer-source-snapshots.md](hosted-timer-source-snapshots.md), [legacy-timer-import-origin-schema.md](legacy-timer-import-origin-schema.md), [legacy-timer-import-target.md](legacy-timer-import-target.md) — notification and timer migration.
- [ship/interfaces/2026-10-09-clients-local-retirement.md](ship/interfaces/2026-10-09-clients-local-retirement.md) — local connector takeover contract.
- [ship/interfaces/2026-10-18-appendbase-abort-barrier.md](ship/interfaces/2026-10-18-appendbase-abort-barrier.md) — AppendBase abort barrier.
