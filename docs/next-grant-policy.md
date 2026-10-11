# Next grants: policy identity and exact permissions

Connect's OAuth grant ID remains the stable control-plane reference for tokens, revoke and timer storage. A synced collection on runtime `next` additionally has a **single-use log grant UUID** in `next_grant_bindings`. The replica refuses reused grant IDs, including revoked ones.

## Lifecycle
- Hosted approval (new or retained) and local approval finalization queue policy after activation and attested Noise-key copy, in the same transaction.
- Portal, connector and desktop-hosted narrowing queue `grant-revoke old` + `grant new` in **one outbox row** and update the binding atomically. An unchanged projection is idempotent; reactivation of a revoked binding allocates a fresh UUID.
- Revocation/deletion of a `grants` row runs one database lifecycle trigger. It queues the active log UUID's revocation and marks its binding inactive in the originating transaction. This covers user/provider revocation, manifest retirement, inventory/conflict/transfer/suspension bulk SQL and cascading deletion. Duplicate requests do not append a second revoke. The trigger never creates authority.
- Legacy/shadow/device-log grants do not emit policy. Existing next grants without a binding are inactive until explicit reauthorization; no migration backfill invents user consent.
- The existing policy emitter signs/appends the queued intent. A binding or discovery response is not proof of appended policy or live admission. The Noise endpoint enforces confirmed policy.

## No authority broadening
A synced next grant must have a nonempty **exact union** of semantic capability v2 operation groups, a full-collection scope, a valid installation UUID and an attested 32-byte Noise key. Collection setup's paired assess/apply operations are accepted only with definitions.manage. offline.replica is not a thin-client grant.

File actions must also match that union exactly:

| Group | File actions |
|---|---|
| collection.read | list, read |
| records.create | add |
| records.edit | replace, move |
| records.delete | delete |

Neither side is expanded to match the other. Partial/v1 groups, unapproved file rights or independently selected file rights that require extra record rights return `409 application_reauthorization_required`. The application must obtain explicit new consent using representable groups. A finer-grained app use case requires a product decision, not implicit translation.

Cloud-copy grants publish selected folders in `fileFolders`; private grants carry only `folderScoped: true`. Their folder names remain in sealed device approval. Narrowing or key/scope change invalidates prior private approval and requires approval of the fresh log identity.

## Private collection grants
A web application can be granted a Private native collection directly: `grants.next_collection_id` (migration 0073) is the grant's only target, and every grant names exactly one of `collection_id`, `hosted_collection_id` or `next_collection_id`. Consent lists the Private collections the user owns or is a current member of (`kind: "private"`); approval inserts the grant, copies the attested Noise key and queues the log grant in one transaction. Approving again from the same installation replaces the earlier grant.

The grant is an offer. The replica admits the app only under the first valid device-signed `grant_approval` for the log grant; the control plane never admits on the grant row alone. Desktops fetch what to show and sign from `GET /v1/next/grants/:grantId/terms` (an ordinary connector credential of a device of the granting account; installation credentials are refused).

Routing for a Private grant considers only desktop and CLI devices of the granting account whose exact enrolment is appended to the collection's log and never revoked, while the account is a current member. Pipe admission opens only on a device in that set. Token issuance and refresh require current membership.

`availability` on the route (and on native or superseded entries of `/v1/next/apps/collections`):

| `availability` | Meaning |
|---|---|
| `{state: "available"}` | A device is serving (or a hosted target exists). |
| `unavailable`, `no_device_registered` | No device can serve this collection. |
| `unavailable`, `approval_required` | Private: no device has approved the grant yet. |
| `unavailable`, `old_connector_running` | The device is online but an older connector still holds its collections (reported by the daemon in `relay_hello`). |
| `unavailable`, `desktop_update_required` | The device's last relay connection was refused as incompatible. |
| `unavailable`, `device_offline` | The devices are offline. |
| `unavailable`, `access_removed` | The account is no longer a member of the collection. |
| `unavailable`, `sync_required` | The grant's legacy collection was taken over by a native collection, or the collection left Private sync or was deleted. The app must be set up again. |

A native Private entry of `/v1/next/apps/collections` also carries `role` (`owner`, `editor` or `viewer`) while the account is a current member; it is omitted in every other case (removed, left Private sync, deleted, or an unknown role). It is for display and UI gating only: every action is still checked where it lands.

A member's grant is bound to the membership policy it was approved under: removing the member, or changing their role, revokes it (and its log grant). Re-adding the member needs new consent. Token refresh repeats the consent authority check (`application.authorize` on a current Private collection).

**Deploy order.** A server version older than this change refreshes a native grant's tokens without the collection checks (the tokens open nothing on that version, but would on a newer one). Roll the new server out fully before any native grant is created. Any future change that moves a collection from Private to cloud copy must revoke its native grants first.

## Consumer mapping
- `/v1/next/collections/:id/route` and `/v1/next/apps/collections`: `grant` is the log UUID used for Noise. When different, `authorization_grant` is the stable Connect UUID used for control-plane lifecycle.
- Relay pipe admission, current-grant revalidation and the next-device policy feed use the current active binding. A superseded log UUID cannot open a new pipe.
- Private approval reports sign `grantApprovalReportDigest(collection, **log UUID**, ...)`. The report endpoint accepts either current log UUID or stable Connect reference; it stores the report under the Connect UUID and binds its terms to the current log identity. Stale log UUIDs/old signatures are rejected.
- Timer control storage keeps the stable Connect UUID; the resolver can translate a current log UUID supplied by a hosted shim.

## Tests / deployment
`src/features/next/grant-policy.postgres.test.ts` is included by Server CI's existing `vitest run src/features/next` Postgres step. Run Postgres suites sequentially to avoid the database-wide migration advisory lock's 5s timeout across isolated-schema test setups. The suite uses only an explicitly approved local disposable test database and owns/drops its schema.

Migration 0057 is additive. pg-mem can model the binding schema, not PL/pgSQL trigger behavior; real PostgreSQL tests qualify grant publication, narrowing, rollback, concurrency, bulk revoke, cascading deletion, reactivation and route/report mapping. No production or LAB deploy is part of this change.
