# Sharing synced collections

The existing `/v1/hosted/collections/:collectionId/invitations` and member routes
also serve current native cloud-copy and private synced collections. They retain
browser account authentication, collection management permissions, invitation
verification and member seat limits. A native collection does not need a legacy
hosted-provider row. Shadow collections retain legacy sharing authority until
cutover; unavailable native authority never falls back to a retained legacy row.

Membership changes and their `member-set`/`member-remove` policy operations commit
in the same database transaction. The existing policy emitter publishes them to
the collection's log. Invitation creation alone grants no membership. Device JOIN
requires acknowledged membership and an exact registered-device proof; CREATE
remains owner-only. Installation credentials retain their explicit collection scope.

A native member role PATCH requesting Viewer waits for the same bounded log
publication barrier as member removal, including a repeated Viewer request after
an uncertain response. Role changes awaiting provider cleanup also wait for their
temporary Viewer policy before returning `202`/`changing`. Ordinary upgrades
without provider cleanup retain their existing behavior.

Confirmed responses retain the existing membership JSON and `200`/`active` or
`202`/`changing` status. If publication fails, is parked, is unavailable, or exceeds
the eight-second HTTP wait, the route instead returns `503`, `Retry-After: 2`, and
`{ "error": { "code": "collection_sharing_unavailable", "message": "Member role change is not yet confirmed. Retry the request." } }`,
matching removal's error shape. The database change remains committed; this is an
uncertain confirmation, not rollback. The durable outbox retains the original batch
bytes for retry or recovery; the HTTP timeout does not cancel publication. Parked
batches need the existing operator recovery. Retry a Viewer PATCH once the membership is active, or use
the member list (which also waits for publication) to confirm a pending change.
Existing management clients, including the portal linked from Editor/apps, already
surface non-2xx errors; they must not interpret this response as completed removal
of write access. No new response fields or membership states are introduced.

A queued offline write can still land before the Viewer policy's log position.
Once that policy lands, every later content append is checked against Viewer
authority, including retries using a token minted while Editor. Native device log
tokens keep their 15-minute lifetime and remain renewable: they identify an enrolled
device and permit reads, while the current log policy decides write authority.
Downgrade therefore does not revoke the device or invalidate its log token.

Role changes awaiting legacy provider revocation project viewer authority to the
native log until cleanup finishes, then publish the requested role. This does not
restore the old provider credentials: those remain revoked while CP membership is
`changing`. Temporary role changes never use `member-remove`, which permanently
revokes the account's enrolled devices and derived grants and requires rekeying.
Removal publishes that operation immediately, while member seats stay reserved
until existing provider cleanup completes. Re-invitation requires a fresh device
identity rather than restoring a revoked historical enrollment.
Deleting an account publishes the same `member-remove` to every current native
collection it belongs to, and records a permanent deletion denial for each native
collection it owns before those rows are erased.
Migrating a hosted collection carries its members into the new target's policy
before the cutover: `member-set` with the current role for each active member,
`viewer` for a member whose role change is still pending provider cleanup, and
nothing for revoking or revoked members or pending invitations, which stay in
Connect. A repeat queues only the difference, including `member-remove` for a
member who left during the migration.

Policy publication is not key delivery. After authorized device enrollment, the
existing hosted/escrow or private-device keying mechanism supplies encrypted keys.
The control plane does not receive collection plaintext or private collection keys.
