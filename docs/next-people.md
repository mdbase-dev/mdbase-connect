# Next people profiles

The existing `GET /v1/authorities/:collectionId/identity` and `/members` paths
remain the control-plane people API. For a consenting next account, each profile
adds `account_id` (the exact account UUID in confirmed policy and record
`createdBy`/`modifiedBy`). `issuer`, opaque `subject`, `name`, role and settings
navigation remain unchanged. Legacy responses remain unchanged.

Identity and member listing still require their separate, exact user-approved
`people_permissions`. Tokens must be live and tied to the current application
manifest and collection/member-policy revision. Synced next grants additionally
require an active log-grant binding. Caller and owner suspension, grant/token
revocation and inactive authority deny access. Emails and invitations are omitted.
The SDK can cross-check UUIDs/roles against confirmed replica policy; this metadata
is not proof of policy publication or membership admission.

Installation credentials are not accepted by this change. Their people access
will be added together with C5's explicitly user-approved collection scopes;
device enrollment alone must not widen collection discovery.
