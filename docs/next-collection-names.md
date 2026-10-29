# Synced collection names and deletion

Every next synced collection (cloud-copy or private/E2E) has one shared cleartext control-plane catalog label. Its UUID remains its identity. Names are display-only: they do not authorize content access, prove enrollment/readiness, change grants or keys, or rename local folders/files. Duplicate names are allowed. Device-local registry aliases are separate.

## Initial name

`POST /v1/next/collections/cloud-copy` (device proof), `POST /v1/next/collections/cloud-copy/service` (account session), and `POST /v1/next/collections/private` (owner-device proof) accept optional `display_name` alongside their existing fields. Omission uses `New collection`. The label is stored with the first registration and genesis transaction. Existing-collection retries never update it, including after a subsequent rename. Bootstrap response shapes and cryptographic create digests are unchanged.

Clients must capture the normalized initial-name intent in their original durable create outcome before any await/HTTP work. Omitted and explicitly supplied names are distinct intents, even if their displayed text is equal. A pending/unknown operation cannot change its name or collection target. Preserve older omitted-name outcomes and key custody. A separate explicit fresh create after completion may start a new operation/target.

## Rename

`PATCH /v1/next/collections/:id/name`

```json
{"display_name":"Research"}
```

Response (metadata only, `Cache-Control: no-store`):

```json
{"collection_id":"11111111-1111-4111-8111-111111111111","display_name":"Research"}
```

Only the current owning account may rename. The original ordinary desktop/CLI or dedicated installation credential must still be current; the exact registered device must have acknowledged, nonlost enrollment and current owner membership. An installation additionally needs explicit approval for this collection; existing installation consent remains cloud-copy-only and does not admit private renames. Ordinary owner desktop/CLI credentials may rename either sync mode. Create consent alone does not authorize arbitrary renames. Revocation, removal, suspension, permanent deletion, a noncurrent/shadow/left collection and a frozen legacy migration refuse the mutation. No provider call is made; retained legacy/provider/archive labels are not renamed.

Writes serialize per collection and **last committed rename wins**. There is no CAS, revision, request-ID replay ledger or automatic retry. A lost/uncertain response remains UNKNOWN: refresh the authorized catalog and show the observed current name. Equality with the requested name is not proof that that request committed. An already-inflight request can commit after another rename; commit order, not user-intent time, determines the label. Any subsequent mutation needs a fresh explicit user intent.

The existing approved-collection list keeps exactly `collection_id`, `display_name`, `role`. Its cloud-copy label source is the canonical CP column rather than a live legacy/device alias; the approved installation list remains cloud-copy-only. Existing authorized application grant tokens/catalogs use the canonical label for both synced modes, without widening readers. Cached offline names are display-only, not authority or a committed offline rename.

## Delete

`DELETE /v1/next/collections/:id`

```json
{"confirm_name":"Research"}
```

Response (`Cache-Control: no-store`):

```json
{"collection_id":"11111111-1111-4111-8111-111111111111","deleted":true}
```

The same owner, credential, enrolment, installation-scope and migration-freeze checks as rename apply. `confirm_name`, after trimming, must equal the collection's current name (`New collection` when it has none). That check sits on top of the client's own confirmation. Deletion cannot be undone. In one collection-locked transaction it:

- records the collection's permanent deletion fact, which the log-token, bootstrap, join, create, rename, sharing and hosted-route paths already refuse;
- revokes every application grant on the collection for every account, with their access and refresh tokens, and queues each bound log grant's revoke;
- removes every installation's approved scope for the collection, and revokes its native background grants;
- writes a `next_collection.deleted` audit event.

After the commit, the control plane sends the same deletion tuple to the native registry to record a permanent denial floor. That call records denial only. If it fails or its reply is lost, the outcome is unknown, while the control plane's denial stays in force. The server then logs a warning with the collection ID, deletion ID, lifecycle epoch and error class, and no credentials. An operator reruns the call with `pnpm --filter @mdbase/connect-server next:deletion-floor rerun <collection id>`, using the server's database and next control-plane environment. The rerun sends the same committed tuple, so retrying is idempotent. If the registry already holds a different tuple, the rerun reports the refusal and changes nothing.

Deletion is a soft delete. The collection row, its log and any hosted copy are kept, unreachable, until a separate erasure stage. Nothing in this route claims the data was erased. There is no archive or undelete.

Refusals use these codes:

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Missing identifier or `confirm_name`. |
| 404 | `not_found` | Not this account's collection, already deleted, or the credential is not current. |
| 409 | `collection_name_mismatch` | `confirm_name` does not match the current name. |
| 403 | `not_owner` | The account is a member but not the owner. |
| 409 | `not_member` | The account is no longer a current member. |
| 403 | `installation_collection_not_approved` | The installation was not approved for this collection. |
| 403 | `installation_not_current` / `identity_not_current` | The installation or device sign-in is not current. |
| 409 | `device_revoked` | This device's access to the collection was revoked. |
| 409 | `device_not_enrolled` | Join this collection on this computer first; acknowledged, nonlost exact enrollment is required. |
| 409 | `migration_frozen` | The account's upgrade is in progress. |
| 503 | `busy` | Another change holds the collection; try again. |

Each refusal carries a plain-language `error.message`.

For both rename and delete, a current owner whose device has no acknowledged,
nonlost exact enrollment receives **409 `device_not_enrolled`**: "Join this
collection on this computer first, then try again." Enrollment remains required;
this response never enrolls a device or bypasses approval. Other accounts and
unknown collections retain their existing responses, including `404 not_found`.

The next runtime CLI exposes this route as
`mdbase collection delete <name-or-id> --confirm <current-shared-name>` through
the daemon's existing owner-device credential after control-key authentication. A registered name or unique ID
prefix resolves locally; a full collection UUID also works before local
registration, so the server can explain missing enrollment. Duplicate local names
require an ID. Confirmation always uses the **current shared name**, which may
differ from the local alias. `--yes` does not replace `--confirm`.
Network failures and malformed replies after deletion dispatch report `outcome_unknown`;
they do not establish refusal. The command does not retry an uncertain response. Refresh the authorized catalog
before deciding on any further action; a lost response is not proof of failure.

Hosted deletion leaves local registration and files intact. Separately run
`mdbase collection remove <name-or-id>` to unregister the local folder; `remove`
does not delete the hosted collection or local files.
The success message prints the corresponding `mdbase collection remove <id>` command.
Acknowledged deletion adds a `collection_deleted` entry to local activity;
refused or unknown outcomes do not add a success entry.

## Validation and privacy

For new writes, reject nonstrings, malformed UTF-16, U+0000–001F/U+007F–009F controls and U+2028/U+2029 separators **before** trimming. Apply JavaScript `String.trim()`, require 1–200 UTF-16 code units (`length`), and perform no case/Unicode/path normalization. Render names as text and bind consequential selection/consent to the UUID, not a mutable label. Never automatically upload a local path/alias as a shared name.

Names are cleartext CP metadata, including private/E2E synced collections (Callum's 2026-10-09 product decision). Only the collection label is cleartext: private contents, folder names, keys, wrapping and device approvals remain end-to-end encrypted; naming never enrolls hosted/escrow devices or changes policy. Native local-only names remain device-local and are never uploaded automatically.

Migration 0064 is unchanged: it preserves already-cleartext legacy labels verbatim, including private/suspended-owner rows, without widening readers; a private row without a previous label remains NULL until explicitly renamed. Backfill prefers the same owner's hosted label, then the stable first nonremoved same-owner local registration. New registration in either synced mode supplies an explicit/default label; old unnamed synced writers have the same presentation default during a rolling upgrade. This is not an encrypted replicated settings record or a second synchronized name source.
