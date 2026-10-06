# Negotiated next account identity

`next_account_v1` is opt-in and requires `next_device_v1` and successfully
negotiated `policy-freshness-lease-v1`. `lease_v1` is an internal policy mode,
not a capability literal. It is not added to legacy default or required
capability arrays. A claimed new mode without its dependencies or server next
support is rejected, not downgraded to an accountless session.

Successful normal pairing returns `account_id` alongside the existing connector
and credential fields. It is the authenticated approved user's canonical UUID,
not the connector ID. Pending/error results have no account identity. Consumers
persist it with their server/connector/account-epoch fence; old missing fences
require fresh normal pairing, not metadata or token-derived backfill.

In the negotiated mode `policy_snapshot.grants[].account_id` and
`authorization_activation_request.grant.account_id` come from the stored
consenting grant account. They are not inferred from collection creator, device
owner, email, token claims or client JSON. The feed's raw canonical revision
includes the field. Consumers retain it unchanged into the cache and durable
identity checks. Account-only changes therefore change the raw revision.

Legacy and existing-next-device-only projections omit the account field exactly.
The TypeScript optional field and Rust default/skip-None field describe that
legacy shape, not authority: new local serving requires a canonical nonzero
ordinary account and rejects missing/invalid/service/local-owner mismatch.
Synced/shared authorization instead uses current signed membership and role,
not creator equality. No global triple-owner filter is introduced.

This wire contract does not change application signing transcripts, advertise
new support in typed legacy clients, grant data access, or enable next features.
