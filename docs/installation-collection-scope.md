# Installation collection consent (C5)

First-party installation approval is scoped to explicit cloud-copy UUIDs, not an account inventory or all/future collections. Existing installations start with **no approved collections and no create capability**; historical enrolment alone never supplies consent. Ordinary daemon credentials keep their existing controls. Application grants keep their exact declared people/capability permissions.

## Initial sign-in and first-run creation

The existing strict `installation` START object adds optional `requested_create_collections: boolean` (default false). Persist this field with the original request/secret/actor before START; changing it on replay or closed-window renewal refuses. The portal displays current named cloud-copy collections for which the selected account is a current member. None is selected by default. It displays **Create new collections** only when requested; that checkbox also defaults to denied. Approval sends `{fingerprint, collection_ids: [<explicit lowercase nonzero UUIDs>], create_collections: boolean}`. The exact approval is immutable; replay cannot change it.

A successful initial exchange adds `collection_ids` and `create_collections` to the original paired receipt. A missing scope means no collection access, not a compatibility fallback. Creating without the capability returns `409 installation_create_consent_required`; show explicit re-consent, do not rotate/retry another actor. A newly created UUID is added to **this installation's** approved set in the same transaction as genesis/service-device persistence. It gives no access to any other collection. Existing-UUID creation retries require that UUID's scope; they do not create implicit scope.

## Already registered installations: additive re-consent

Use the same `POST /v1/pairing-requests` channel with the installation bearer, exact original installation/device/kind/app ID/Origin, a **new protected request ID and secret**, `installation.reconsent: true` and the desired `requested_create_collections` boolean. No `renewal` field. This authenticates the existing credential; it is not a second registration, account replacement or key rotation. It works even if the original pairing window was deleted. Replaying START also requires that same current credential.

The existing `/pair/:id` portal shows the original device fingerprint, retained approved UUIDs/create capability (not removable here), and unchecked new eligible UUIDs. Account selection and native attestation are already established by the current credential. The user approves **additions** only. Approval requires a current same-account session; unconsumed exchange refuses if that account's session epoch changed after approval. Denial/expiry does not alter existing scope. Access is added only by the original-secret exchange after approval and a fresh current-credential/member check.

Exchange returns `200 {status:"scope_updated", ...original selection, added_collection_ids, approved_create_collections}`. It never returns a replacement bearer or registration: keep the original connector/device/sign/KEM/Noise keys and credential. Repeated/lost committed replies return the same approval receipt without reapplying its additions. A revoked/removed/substituted credential refuses; no recovery creates another actor. Re-consent cannot revoke existing access or disable retained create authority. Removal is a separate explicit operation with native device/grant revocation, never an unchecked consent checkbox.

The portal's **Remove access** confirmation states: “This app will lose access to X on all its devices.” `POST /v1/pairing-requests/:id/remove-access` requires a current same-account session, a live scope-only window and `{collection_id, confirm:true}`. It atomically removes that UUID from all same-account TaskNotes installation scopes, revokes that account's grants for the fixed `bundle:dev.tasknotes.app` declaration family through #653's immutable log-grant hook, and queues device-revoke for its enrolled TaskNotes web/mobile devices in that collection. Other accounts, applications, collections and create capabilities are unchanged. Response `{ok:true,state:"revoking",collection_id}` means new CP access is refused immediately; log ACL revocation still must append. Repeating it never queues duplicate revokes. Those device/collection pairs cannot rejoin; previously downloaded data cannot be erased. A committed consent receipt replay cannot restore removed scope.

## Collection discovery, join and people

`GET /v1/next/collections` with the installation bearer returns `{collections:[{collection_id,display_name,role}]}` for approved current cloud-copy UUIDs and current native membership only. Display-name fallback is the UUID if Connect has no named metadata. No bearer/key/path/readiness is returned; metadata is not keyed or readable qualification. Ordinary daemon/account credentials are not admitted by this installation list.

Membership follows current non-lost native batch positions, then row/op order, not recovery outbox IDs. Queued or lost removals deny immediately; lost additions/enrolments are not current authority.

`POST /v1/next/collections/:id/devices` keeps its existing cloud-copy-join digest/body. Installation join requires explicit UUID scope plus the account's current native owner/editor/viewer membership (acknowledged member-set, pending removal denies), the exact approved device, active owner/account/credential, current cloud copy and no device-revoke. It cannot add membership, widen scope, join private collections or change keys. Recheck after log/network awaits before minting. Ordinary daemon join remains owner-only.

`POST /v1/next/collections/:id/log-token` keeps its existing digest/body and requires approved UUID scope in addition to its existing current exact acknowledged enrolment/member/device checks. Scope removal/currentness failures never mint.

The same installation bearer may use `/v1/authorities/:collectionId/{identity,members}` only with approved UUID scope, current membership and exact acknowledged enrolment plus no pending/native device-revoke. Profiles preserve `issuer`, opaque `subject`, `name` and member `role`; `account_id` is the additive next UUID. Native effective membership is authoritative; metadata is never inferred from enrolment alone. Portal device consent explicitly includes account/member identity information for the selected entire collections. App-grant callers still need the exact declared `people_permissions`.

## Remaining qualification

Implementation is being qualified on disposable PostgreSQL. No browser/system/LAB or deployment qualification is implied by this contract.
