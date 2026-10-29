# Instance administration

The server image includes a generic, database-backed administration command for
self-hosters and managed deployments. It is intentionally a local command, not
an HTTP administration API. Run it only in a trusted shell or one-shot job with
the same environment and `DATABASE_URL` as the Connect service:

```bash
pnpm --filter @mdbase/connect-server instance:admin -- users list
```

The compiled image entrypoint is
`node services/server/dist/auth-admin-cli.js`. Commands write JSON to standard
output and errors to standard error. The `auth:admin` package-script alias is
retained for compatibility.

## Read operations

User, invitation, policy, and audit lists are cursor-paginated and accept at
most 100 rows:

```bash
pnpm --filter @mdbase/connect-server instance:admin -- \
  users list --status active --limit 25

pnpm --filter @mdbase/connect-server instance:admin -- \
  users show --user person@example.com

pnpm --filter @mdbase/connect-server instance:admin -- \
  invite list --status active

pnpm --filter @mdbase/connect-server instance:admin -- \
  audit list --user-id USER_UUID --event-type account.suspended

pnpm --filter @mdbase/connect-server instance:admin -- policy history
```

Pass the returned `next_cursor` back as `--cursor` to continue a user,
invitation, or audit list. Policy history uses `next_before_revision`.
`users show` accepts an exact UUID or email identity and returns only
operational metadata and counts; it never returns password hashes, session
tokens, invitation tokens, provider credentials, or collection contents.

`entitlements show --user USER_UUID` reports the effective profiles, all grant
history, the control-plane storage account, and provider usage without granting
or provisioning anything. A new account may have `provider_revision: 0` and
`provider_usage: null`: its first hosted operation has not yet provisioned the
provider account. Only that exact provider `hosted_account_not_found` response is
accepted as pending. A missing previously reconciled provider account, an outage,
or any other provider error still fails the command. An account with
`effective: null`, `storage_account: null`, and an empty `grants` array has no
hosted provisioning; do not confuse it with a pending provider account.

`usage report [--days <1-365>]` returns aggregate activation, consent, pairing,
collection, transport, and per-application usage counts in one result. It
contains no identifiers or email addresses. See [Usage report](usage-report.md)
for each figure's source and limits.

## Account operations

Every account mutation requires a stable operator identity, a human-readable
reason, and a UUID operation ID:

```bash
operation_id=$(uuidgen)
pnpm --filter @mdbase/connect-server instance:admin -- \
  users revoke-sessions \
  --user person@example.com \
  --operation-id "$operation_id" \
  --actor operator:example \
  --reason "Sign out every browser after credential rotation"
```

The operation ID makes a retry exact. Reusing it with the same action, target,
actor, and reason returns the stored result without repeating side effects.
Reusing it for a different request is rejected.

Suspending an account is a containment operation:

```bash
pnpm --filter @mdbase/connect-server instance:admin -- \
  users suspend \
  --user person@example.com \
  --operation-id "$(uuidgen)" \
  --actor operator:example \
  --reason "Contain a reported account compromise"
```

It revokes active browser sessions, paired-computer credentials, application
grants and tokens, notification channels, and hosted-replica credentials. User
collections and account identity records are preserved. When hosted
collections are configured, provider-side replica revocation must succeed
before the local transaction commits; otherwise suspension fails closed and
can be retried.

Restoring the account clears its suspension:

```bash
pnpm --filter @mdbase/connect-server instance:admin -- \
  users restore \
  --user person@example.com \
  --operation-id "$(uuidgen)" \
  --actor operator:example \
  --reason "Investigation completed"
```

Restore never revives old credentials. The user must sign in again, pair new
computers, and re-authorize applications. This prevents an accidentally leaked
credential from becoming valid when an account is restored.

## Invitations and policy

Policy updates use optimistic concurrency. Read the current revision, then pass
it as `--expected-revision`; a concurrent update makes the command fail rather
than overwrite newer settings.

```bash
pnpm --filter @mdbase/connect-server instance:admin -- policy update \
  --expected-revision 0 \
  --registration invite \
  --password-auth enabled \
  --email-delivery enabled \
  --terms-version 2026-07-25 \
  --privacy-version 2026-07-25 \
  --actor operator:example \
  --reason "Enable invited password accounts"
```

Create and deliver an invitation after configuring the Resend environment:

```bash
pnpm --filter @mdbase/connect-server instance:admin -- invite create \
  --email person@example.com \
  --entitlement-profile beta_v1 \
  --send-email enabled \
  --token-output omitted \
  --actor operator:example \
  --reason "Approved beta participant"
```

Invitation creation requires an explicit `--entitlement-profile`: use a configured
profile such as `beta_v1`, or `none` for an intentionally local-only account.
Omission fails before creating, replacing, or delivering an invitation. Managed
hosted invitations must specify their promised profile, never `none`. This is an
intentional CLI change: update older operator scripts that omitted the option.
The managed wrapper already supplies `beta_v1`; it requires no compatibility
fallback. The underlying invitation service also requires an explicit profile or
`null` for local-only use and rejects omitted values at runtime, so direct
JavaScript callers cannot silently omit the decision. No default profile is
inferred from registration mode or email address.

Self-hosters may omit delivery and receive the one-time invitation URL on
standard output. Treat that output as a credential. Managed wrappers should
force `--send-email enabled --token-output omitted`.

Invitation delivery uses `invitation/<invitation-id>` as the provider
idempotency key. `invite resend --id ...` intentionally creates a replacement
invitation and emails it; the previous active invitation becomes invalid.
It preserves the existing entitlement profile unless explicitly overridden with
`--entitlement-profile`. If the original has no profile, resending requires an
explicit profile or `none`; it cannot silently perpetuate an unentitled invitation.
Use `--email-template signup-recovery` only when replacing an invitation whose
signup failed because of a confirmed service incident. It sends the apology
and fresh one-time link together without exposing that credential to an
operator or marketing system. Standard resends omit the option.
Invitation revocation is an exact-replay mutation and therefore also requires
`--operation-id`.

## Parked Next policy queues

Non-CBOR HTTP failures are transport failures and retry automatically, including
429 (rate limited), 403 and 413. A CBOR semantic refusal still parks its batch
and blocks later policy work for that collection.

Inspect the parked batch's `collection_id`, `id` and `error` in
`next_policy_batches` through your trusted database tooling. After resolving the
cause, allow another attempt for exactly one collection:

```bash
pnpm --filter @mdbase/connect-server instance:admin \
  policy-outbox unpark --collection COLLECTION_UUID \
  --operation-id "$(uuidgen)" \
  --actor operator:example \
  --reason "Corrected the proxy configuration that refused policy publication"
```

This transaction changes parked batches to `sending`, clears their current
error and records the batch IDs and previous errors in `next_policy.unparked`
audit events, alongside actor, reason, operation ID and timestamp. It uses the
same collection lock as the emitter and recovery. It preserves signed bytes,
positions, attempts and queued operations. The next emitter drain resends the
original bytes before later work; a semantic refusal parks again. This command
does not repair a missing genesis, corrupt retained operations or expired
signatures: resolve those causes before retrying.

The result lists `batch_ids` (empty when nothing is parked). A missing collection
is an error. Reusing the same operation ID returns the stored result and never
unparks a subsequently refused batch; use a new operation ID for a new attempt.
Read the audit with `audit list --event-type next_policy.unparked`.

`/ready` continues to return HTTP 503 with `next_policy: "parked"` while any
batch is parked, preserving the production monitor's incident signal. Use
`/health` for process health and routing, as the self-hosted Compose and managed
Render configurations do. A collection's policy refusal must not remove the
whole Connect instance from rotation or block other services' startup.

## Audit and deployment properties

Mutations write actor, reason, subject, timestamp, and operation metadata to
the append-only audit stream used by `audit list`. The operator-operation table
stores only mutation results needed for replay; it does not store raw
credentials.

Schema changes are additive and applied by the normal server migration. Older
application builds ignore the new columns and tables, preserving the normal
expand-first rollback window. Do not bypass the command with ad-hoc SQL:
doing so can omit provider revocation, credential invalidation, idempotency,
and audit records.

Deployment-specific wrappers, production confirmations, platform resource IDs,
operator rosters, and email-provider credentials belong in the deployment
operator's private infrastructure repository.
