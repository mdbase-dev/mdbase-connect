# Local collections awaiting the desktop upgrade

Next-only clients can receive HTTP 409 with code `collection_not_yet_migrated`
and this message:

> This collection will appear here once you update the mdbase desktop app on the computer that holds it.

This is not `collection_migrating`: no upgrade is asserted to be running, no
completion deadline is promised and no automatic retry interval is supplied.

## Source of truth

The CP must positively find the exact current local authority registration in
`collections`: present, enabled, active, not removed, owned by the requesting
account, on its still-current connector. The owner must not be suspended.
A connector registered in `next_devices` is not a legacy connector (the same
distinction enforced by local takeover). A `next_collections` shadow/next row
also disqualifies this explanation; existing migration/readiness rules still
apply. New local-only collections legitimately have no log or
`next_collections` row, so absence there alone never establishes legacy state.

Account backend, connector version, relay presence/offline status, arbitrary
error messages and missing routes are not migration markers. Upgrading a
different desktop on the same account does not upgrade this collection.

## Consumers and authorization

- An activated, unrevoked, collection-scoped access token asking for its next
  route receives the typed refusal before being asked for another key or
  approval. No legacy route is returned.
- The same installation's already-visible local grants retain their existing
  inventory visibility, carry unavailable `collection_not_yet_migrated`, and
  are not marked routable even if a Noise key was registered.
- Signed native approval may explain the authenticated owner's legacy target
  but does not mint a grant, token, policy or installation scope.
- Recovery may explain an explicitly confirmed portal account's own stored
  recovery target. Pre-confirmation requests and URL hints never cause this
  lookup. Foreign/missing targets retain the same ordinary unavailable answer.

No local collections are added to cloud-copy installation scope, no unapproved
collection is exposed to an app and no legacy credentials are substituted.
Next enrollment/takeover clears the legacy marker, but normal current authority,
membership, key, policy, scope and serving checks must still pass. Existing
post-takeover `sync_required` and active-migration outcomes are unchanged.
