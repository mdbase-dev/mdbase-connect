# Native installation reminders

An installation credential and collection scope are not timer permission. Native
reminders require separate explicit consent to the registered application's timer
declaration, bound to the original installation and exact selected collection.
The original request freezes that declaration; replay cannot adopt a changed
manifest or invent consent on a historical or consumed request. Declaration
digests and public receipt references are metadata, not authentication.

## Approval and withdrawal

The collection approval screen has one plain-language reminders control.
Declining or omitting timer permission still completes device/collection setup;
reminders remain off, with reapproval available from the application. The control
covers only the request's newly approved collection IDs and its explicitly chosen
collection, never every retained scope or permission to create future collections.

Initial grant issuance shares the original credential-exchange transaction.
Reconsent uses the already registered credential and applies the timer decision
at approval: explicit withdrawal permanently revokes the old grant immediately,
without waiting for the application to exchange its response. This prevents an
older delayed exchange from reviving a permission withdrawn by a newer request.
A new explicit approval creates new grant IDs; denial revokes grants from that
request. Public receipt references replay their original recorded grant IDs,
including revoked historical references; they are not proof of current authority.

## Shared background identities

Migration `0069_native_background_grants` gives the existing timer, receipt and
notification stores one typed identity: a real legacy grant retaining its ID, or
an actual installation timer grant. Native identities never enter `grants`.
Original installation/device/kind and all three registered public keys are bound
by a composite foreign key. Consent and identity are immutable; revocation is
permanent. Removing an exact collection scope or revoking its connector revokes
native timer consent without replacing keys or installation custody.

The migration backfills real legacy IDs, retains raw legacy insertion and delete
cascades, and repoints six backing foreign keys. It preserves timer generations,
namespace revisions, event/operation receipts and sealed channel targets.
The memory adapter runs schema only; real PostgreSQL qualifies the hooks, FK
upgrade and native identity constraints. Neither schema nor declaration metadata
alone enables native timer authorization, delivery or a host port.

## Current native authority

The shared resolver never treats a recorded native principal as a legacy grant.
It rechecks the original account/application/installation/device/kind and all
three keys, the current registry environment/origin and frozen declaration,
exact collection scope, active owner/collection lifecycle, acknowledged membership
and exact acknowledged enrollment. Pending device revocation or member removal
denies immediately; a historical enrollment is not sufficient. The canonical
collection/device check is shared with People rather than duplicated.

Reads own a bounded transaction; calls from an engine transaction retain policy
and live-consent locks through its commit. A pruned pairing window does not erase
registered custody or grant provenance. Native timers are always opaque: even a
cloud-copy native collection does not authorize plaintext timer data. The native
credential is not the connector's unused ordinary-controller token. The resolver
alone does not enable runtime reminders.

## Installation timer requests and receipts

The additive v1 installation route is
`/v1/next/collections/:collection/background-grants/:grant/timers/:namespace`.
It mounts the same timer operations and original-operation receipt engine, not a
second store. Both path IDs are fixed by the original public approval reference;
only the grant's genuine dedicated installation bearer authenticates a request.
The receiver rechecks that credential inside the engine transaction and checks
current authority before mutation and commit. A grant reference, account cookie,
other installation or ordinary connector bearer is insufficient. Existing OAuth
routes and hosted/internal shims do not admit native installation authority.

Native identity/policy locks precede the shared grant/namespace locks, with another
current check after waiting. Legacy requests retain their original post-wait token
expiry, revocation and P-256 proof checks. Native receipt recovery binds the actual
original immutable consent/device/key tuple and exact approval microseconds; it
never manufactures a legacy proof key or changes installation custody. Replay and
read-only lookup use the existing operation identity, request/terms digests and
intent revisions. Missing remains UNKNOWN, and revoked consent cannot recover a
receipt. No request or receipt authorizes native timer data.

These routes require the actual native resolver. The shared worker resolves
native policy before timer-row writes and consumer-receipt insertion, rechecks
before firing, and consumes unusable events without creating signals. Native
withdrawal cancels future scheduled timers as well. Concurrent workers retain
the existing generation CAS, event identity and consumer receipt uniqueness.
Signal production uses the original frozen native notification declaration and
the existing sealed channel/subscription/delivery queue, not a legacy grant join.

The existing native-control-plane and timer flags select one configured native
resolver shared by timer routes, worker, notification consumer/service and channel
routes. Its registry environment must be explicitly lab, staging or production;
there is no hostname inference or native-to-legacy recovery on invalid settings.
No runtime flag or deployment is changed by this wiring.

## Installation reminder channels

Registration and deletion mount the existing channel engine at
`/v1/next/collections/:collection/background-grants/:grant/notifications/channels`
(and `/:channelId` for deletion). The same current installation authority checks
apply before channel writes and commit, with policy locks held. The installation
ID must be the actual original installation; criteria are limited to its frozen
timer consent. Other installation/account cookies, ordinary connector credentials
and legacy channel routes do not authorize these operations.

Native targets require configured sealing; missing keys refuse rather than storing
plaintext. Web Push and managed FCM retain the existing target sealing and
subscription machinery. Managed FCM requires the frozen declared project and
configured transport. A native registration cannot delete another grant/account's
channel merely because it has the same FCM token. Unregistration is exact-grant
and explicit; closing a host is not deletion of persistent channels.

Transport delivery and the adopted-host timer port remain integration work.
Producing a queued signal or registering a channel in tests is not delivered or
enabled reminders.

## Upgrade evidence and down-path limit

The isolated PostgreSQL test constructs the actual predecessor using unchanged
migration bytes, verifies the landed `0068_next_service_claim_challenges` and
`0070_installation_portal_provider_identity` ledger checksums, and uses synthetic
production-shaped data: 48 legacy grants, 192
scheduled/firing/fired/cancelled timers at noninitial generations, namespace
intents, event and operation receipts, sealed push targets, subscriptions,
signals and in-flight deliveries. It checks exact complete inventories across
upgrade and repeated migration, preserved decrypted targets, actual FK targets,
raw insert/delete cascades and permanent native revocation. It also checks an
actual pre-migration consumed request stays without timer consent on replay.

The canonical migration runner applies DDL and its ledger entry transactionally.
An intentionally incomplete predecessor causes failure; the test confirms its
existing synthetic data survives and neither new schema nor ledger admission
remains. This does not establish compatibility with every historical schema.

There is no automatic down migration. Once native identities or their children
exist, legacy-only FKs and an old resolver cannot represent them. A test adds a
real native timer and verifies restoring the legacy FK fails without removing
that timer. Do not erase native grants, timers or receipts, relabel them as OAuth
grants, reset generations or unseal/reseal targets to force a downgrade. Any
rollback must retain compatible schema and authorization semantics; otherwise
use a separately guarded forward repair. These source tests do not authorize a
production read, deployment or operational rollback.
