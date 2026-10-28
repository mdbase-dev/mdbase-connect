# Shared service cloud-copy bootstrap

`features/next/service-cloud-copy.ts` owns the existing service-device generation,
service storage, genesis outbox registration, exact log readback and public reply
metadata for service-created cloud copies. It also supplies those same primitives
to the owner-device bootstrap/join path; no parallel migration creator is added.

Internal composition API:

```ts
createServiceCloudCopy(options, {
  collection, owner, runtime: "shadow" | "next", displayName,
  current: async (client) => { /* current authorized principal/claim */ }
})
```

The public service route hardcodes `next` and supplies its existing session/account
currentness callback. A migration caller will hardcode `shadow` and must supply its
current started-owner/source claim. There is no public runtime selector, migration
credential fallback or account-backend promotion in the helper. Suspensions and
accepted account/collection deletion remain the caller's authorization boundary.

Current-principal checks precede collection locks, service generation, outbox
registration, emitter work, log head reads and final metadata publication. No
network await holds the owner/collection transaction. Service keys are generated
only by the existing deployments and stored together with the same genesis outbox.
The first committed tuple wins; retry never substitutes newly generated identities.
Existing collections must match immutable owner/cloud-copy/root/runtime and still
be synced. Public new creation additionally respects legacy topology freezes.
Permanent collection deletion floors refuse before generation or final commit.

The result includes exact appended genesis bytes, public service identities and
observed log head only. It does not include target epoch keys, unwrapped private
service keys, record payloads or `verified`/`ready` flags. Native service activation,
keying, fresh FULL admission, migration source witness and gen0 readback are
separate qualifications; neither a row nor an HTTP response supplies readiness.

Tests use isolated local PostgreSQL and synthetic log/service peers. They exercise
public regressions and SHADOW tuple/retry/freeze/deletion boundaries, not managed
migration, custody or deployment. The dedicated migration target route is separate.

## Account collection allowance

`registerNextCollection` enforces `effectiveEntitlement().maxHostedCollections`
inside the registration transaction, serialized by an account-scoped transaction
advisory lock. The lock spans the count, collection insert and genesis outbox
insert; rejection rolls back registration before log publication or service-device
storage. Stateless candidate service keys may already have been generated.

As defined by the free entitlement profile, this is a **synced collection** limit:
owned `next` Cloud Copy and Private collections count, including pending genesis
publication. Local-only collections, collections whose sync has been left, and
permanently deleted collections (deletion facts) do not. Sharing a collection does
not multiply its cost, and joining somebody else's collection does not consume
the member's allowance. This preserves legacy's owner-account accounting rather
than counting grants or memberships. SHADOW migration imports are existing legacy
collections, not new creates, and remain outside this admission check.

Account creation, service and owner-device cloud-copy bootstrap (including
local-to-cloud copies), installation pairing, Private bootstrap and native starter
onboarding all use this registration boundary. A starter uses one ordinary slot,
as on legacy; it has no exemption or extra allowance. The separately mounted
native starter onboarding path therefore inherits the same gate. An existing
collection's idempotent retry does not register again or require a second slot.

At the limit, creation returns HTTP 429 with legacy's
`account_collection_quota_exceeded` code and an account collection-limit
message. It deliberately does not reuse `quota_exceeded`, which clients read as
"out of storage". No entitlement fails closed through the
existing `hosted_entitlement_required` error. Previously over-limit accounts keep
all existing collections visible and accessible; only new registration is refused.
The idempotent account-creation intent may remain for a retry after freeing a slot;
it is not a collection and consumes no allowance.
