# Next people profiles

The existing `GET /v1/authorities/:collectionId/identity` and `/members` paths
remain the control-plane people API. For a consenting next account, each profile
adds `account_id` (the exact account UUID in confirmed policy and record
`createdBy`/`modifiedBy`). `issuer`, opaque `subject`, `name`, role and settings
navigation remain unchanged. Legacy responses remain unchanged.

For application grants, identity and member listing still require their separate,
exact user-approved `people_permissions`. Tokens must be live and tied to the
current application manifest and collection/member-policy revision. Synced next grants additionally
require an active log-grant binding. Caller and owner suspension, grant/token
revocation and inactive authority deny access. Emails and invitations are omitted.
The SDK can cross-check UUIDs/roles against confirmed replica policy; this metadata
is not proof of policy publication or membership admission.

## Registered next devices

The same routes accept `idev_` installation credentials and ordinary `ct_`
registered-device credentials for current native `private`/`cloud_copy`
collections. Ordinary credentials must supply `?device_id=<exact UUID>`;
installations may omit it to use their credential's device, but an explicit
mismatch refuses. UUID casing is normalized at the route, not used as an alias.
Installation credentials retain their explicitly approved collection scope and
current registration/consent checks. Device enrollment alone never widens their
collection discovery.

Both branches require the exact connector/user/device and original kind/all three
public keys, active caller/owner identities, current acknowledged membership and
an acknowledged exact enrollment tuple. Pending/lost membership or enrollment
never admits access; queued removal denies immediately, and re-inviting an account
does not restore permanently revoked historical devices. Current collection
runtime, not the separate account backend flip, selects native authority; shadow,
left-sync, deleted and suspended authorities refuse without legacy fallback.
Owner availability is locked before the collection, matching membership changes.

Public profiles have the same issuer/subject/name/account UUID shape as above.
Members project acknowledged native policy facts and are bounded to 1000; they
are not a proof of key delivery, policy publication or live filesystem permission.
The SDK combines these metadata endpoints with a complete native
`query_contract_v1` Person inventory and checks the metadata collection against
native hello; local record paths/payloads never enter these CP requests.
