# Operations after migration completion

A frozen legacy archive is not an ongoing migration forever. Normal **next-authority** mutations use `requireNextAccountNotMigrationFrozen`; legacy topology keeps `requireAccountNotMigrationFrozen` and `requireHostedCollectionNotMigrationFrozen` unchanged in meaning.

The next guard takes the existing ordered user → member → cohort locks. For every frozen participant it requires the account backend to be `next`, a non-excluded started membership, durable cohort completion (time and revision), and that account's actual flip ledger entry between its start and cohort completion. Merely setting the account backend, starting migration, accepting an archive, or flipping one member of an incomplete batch is insufficient. Missing/inconsistent evidence fails closed. No Hosted collection or nonempty Hosted flip is required for a Private/zero-Hosted account. Fresh accounts with no frozen membership retain their existing behavior.

Completion revision need not equal the present membership revision: normal terminal account erasure can advance membership revision after durable completion. That must not strand remaining migrated accounts. The legacy guard remains strict even in this case. The completion guard changes no cohort, archive, flip, key or consent row. Existing archive acceptance, thaw refusal, migration start/flip and erasure rules are not changed.

`nextAccountsMigrationFrozen` supplies the same policy to Native catalog `can_manage_members`. It is a read-only UI hint, never mutation authorization; mutations always lock and revalidate.

## Caller audit

Paths below are relative to `services/server/src/`. All original strict-guard call sites and direct `frozen_at` consumers were checked.

| Caller | Outcome |
| --- | --- |
| `collection-sharing-authority.ts`: `lockCollectionSharingAuthority` | **Changed for current Native authority only**; allows completed next Native app approval, direct membership, people permission, membership-role and revocation operations. Legacy Local/Hosted branches still use the strict guard. Discovery is revalidated under the same collection locks. |
| `collection-sharing-authority.ts`: `lockCollectionInvitationAcceptance` | **Changed for current Native authority only**; completed next owner may accept its Private/cloud-copy invitations, including zero-Hosted completion. Nonterminal and legacy branches retain the existing migration-invitation evidence/refusals. |
| `collection-catalog.ts`: `listNativeCollectionsVisibleToUser` direct freeze query | **Changed** to the shared next-completion projection; management controls agree with locked mutation policy. |
| `features/next/private-collections.ts`: Private creation | **Changed** to next guard. Device identity, signature/challenge, registry/current-owner and policy checks remain. |
| `features/next/collection-name-routes.ts`: `ownedCollection` | **Changed** to next guard for rename and owner deletion; actual next runtime/sync, current owner device/enrolment, membership and deletion checks remain. |
| `features/next/service-cloud-copy.ts`: creation transaction | **Changed** to next guard; original creation lock, scope, entitlement, principal/device and idempotency checks remain. This also covers the normal starter-collection path. |
| `entitlements.ts`: `reconcileHostedAccountCollections` | **Retained strict**: can adopt legacy provider collections into account topology; quota/contract-only reconciliation is a separate unguarded operation. Not a next storage-settings path. |
| `hosted-capability-lifecycle.ts`: `quarantineMissingHostedCollectionOnTransaction`; deletion worker `deleteCollection` | **Retained strict**: legacy provider quarantine/deletion. Its `accountMigrating` early return deliberately includes next accounts, preventing legacy authority mutation after cutover. |
| `features/hosted/service.ts`: `insertLegacyHostedCollection`; `createHostedCollectionForUser`; `renameHostedCollectionForUser`; `deleteHostedCollectionForUser` | **Retained strict**: all operate on legacy `hosted_collections`, not Native/cloud-copy next authority. Normal next creation/rename/delete use the changed next services above. |
| `hosted.ts`: `upsertCollection` via Hosted collection guard | **Retained strict**: legacy connector catalog/topology registration. |
| `features/authority-adoption/routes.ts`: account confirmation; Hosted prepare; ready/commit preflight and transaction; cancellation | **Retained strict** at every guard: legacy authority adoption, including its cleanup/cancellation. |
| `features/authority-adoption/adoption-store.ts`: `recoverExpiredAuthorityAdoptions` | **Retained strict**: legacy adoption recovery must not rewrite an archived row. |
| `features/authority-transfer/local-to-hosted-routes.ts`: account preparation; local-row preflight; prepare transaction; cancellation; abort preflight | **Retained strict** at all five guard calls: legacy local↔Hosted transfer topology, not Native cloud-copy creation. |
| `features/authority-transfer/hosted-to-local-routes.ts`: pairing; preparation; transfer transaction; commit; cancellation | **Retained strict** at all five Hosted guard calls: legacy authority transfer. |
| `features/authority-transfer/lifecycle.ts`: `recoverExpiredAuthorityTransfers` | **Retained strict**: legacy transfer recovery. |
| `features/authority-transfer/account-cancellation.ts`: `recoverAccountImportCancellation` | **Retained strict**: legacy import cancellation/recovery. |
| `features/next/migration-topology.ts`: `requireHostedCollectionNotMigrationFrozen` | **Retained strict** for every original/extra legacy owner, including completed accounts. The next exception is never called from this wrapper. |

## Other operation families and direct freeze consumers

- **Native and Hosted app approval / installation sign-in:** Native approval reaches the changed current-Native sharing lock; installation pairing and Hosted scope approval have no additional direct freeze guard. Their original account/session epoch, application/manifest, original request/preparation, consent, scope, Noise, completion and ACK checks remain. No Private identifier enters Hosted scopes.
- **Adding devices / account sign-in and sessions:** `features/next/devices.ts`, `device-routes.ts`, Private enrolment and auth/password/connector session paths have no additional topology-freeze gate to relax. They retain current identity/challenge/key/custody checks. A completed-account test registers a second device and enrols it through normal routes.
- **People/sharing:** the common authority locks cover `collection-policy.ts`, `collection-invitations.ts`, `collection-membership-lifecycle.ts` and account people mutations. Positive real-PG coverage creates/accepts Private and cloud-copy invitations and changes/removes their membership after completion. Suspended/deleted/left/native-vs-legacy authority refusals remain covered.
- **Account settings:** profile, identity linking/removal, password, session and next entitlement/settings operations do not read `frozen_at`; no relaxation required. Legacy provider collection adoption remains strict as above.
- **Account deletion:** `account-management.ts` intentionally records frozen-batch erasure intent, then drains only committed readiness. Its freeze identity check stays. A test completes a two-account batch, erases one account normally, and proves the survivor's next authority remains available while legacy topology is still frozen.
- **Archive erasure:** `archive-erasure-admin.ts` checks original unfrozen/current completion/readiness and archive lineage; unchanged. No erasure or retention authority is granted by the new guard.
- **Migration lifecycle:** direct freeze readers in `migration-capture.ts`, `migration-rollout.ts`, `migration-lab.ts`, `migration-sharing.ts` and batch completion/deferred-deletion helpers retain their original archive binding, member assignment, start/flip, audited LAB evidence and thaw rules. The Hosted-specific `requireCompletedAccountMigration`/invitation proof is not weakened or fabricated for zero-Hosted Private approval. The Native completed branch instead uses the account completion proof above.

## Qualification boundary

The first regression was committed RED: a synthetic isolated real-PG account follows ordinary release/freeze/accepted zero-Hosted archive/start/empty flip; ordinary Private app approval then returned `409 migration_frozen`. The fix permits that approval and Hosted app scope approval without modifying the accepted archive or completion/freeze tuple, and thaw remains refused.

Additional isolated PG tests exercise incomplete multi-member batches, missing/inconsistent completion/flip/start/backend/exclusion/order evidence, strict legacy refusal, terminal erasure revision changes, normal Native collection creation, second-device enrolment, rename/delete, sharing and catalog controls. These are product regression tests, **not** a live archive or app FIRSTREADY/read/edit/publish/reload acceptance claim. No LAB state or failed live fixture is modified by this change.
