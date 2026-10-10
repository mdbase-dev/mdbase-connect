# Native installation reminders

An installation credential and collection scope are not timer permission. Native
reminders require separate explicit consent to the registered application's timer
declaration, bound to the original installation and exact selected collection.
The original request freezes that declaration; replay cannot adopt a changed
manifest or invent consent on a historical or consumed request. Declaration
digests and public receipt references are metadata, not authentication.

## Shared background identities

Migration `0068_native_background_grants` gives the existing timer, receipt and
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

## Upgrade evidence and down-path limit

The isolated PostgreSQL test constructs the actual predecessor using unchanged
migration bytes and synthetic production-shaped data: 48 legacy grants, 192
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
