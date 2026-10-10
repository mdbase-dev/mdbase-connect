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

Role changes awaiting legacy provider revocation project viewer authority to the
native log until cleanup finishes, then publish the requested role. This does not
restore the old provider credentials: those remain revoked while CP membership is
`changing`. Temporary role changes never use `member-remove`, which permanently
revokes the account's enrolled devices and derived grants and requires rekeying.
Removal publishes that operation immediately, while member seats stay reserved
until existing provider cleanup completes. Re-invitation requires a fresh device
identity rather than restoring a revoked historical enrollment.

Policy publication is not key delivery. After authorized device enrollment, the
existing hosted/escrow or private-device keying mechanism supplies encrypted keys.
The control plane does not receive collection plaintext or private collection keys.
