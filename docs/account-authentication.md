# Account authentication

mdbase connect separates an account from the identities and credentials that
can authenticate it. This keeps account ownership stable when an email address
changes, a password is added to an existing Google or GitHub account, or a
future passkey is enrolled.

## Identity model

`users` is the durable account boundary. Authentication data belongs to one of
the following tables:

- `external_identities` binds an immutable provider subject to an account;
- `email_identities` binds a normalized, optionally verified email address;
- `password_credentials` stores one versioned password hash for an account;
- future passkey and TOTP credentials should use separate credential tables.

Matching email text never links accounts. Linking requires an authenticated
session for the existing account plus fresh proof of the identity being added.
An OAuth callback may update presentation data for its existing provider
subject, but it cannot claim an email identity owned by another account.

Email normalization is deliberately conservative and versioned. Version 1
trims outer whitespace, applies Unicode NFC, lower-cases the local and domain
parts, and converts international domain names to ASCII. It does not remove
plus-tags, remove dots, or apply provider-specific alias rules. Active
normalized addresses are unique; retired identities remain available for
audit while no longer reserving the address.

## Password credentials

New passwords are hashed with Argon2id using a unique library-generated salt
and an encoded PHC string. The current minimum work factors are:

- 19 MiB memory;
- two iterations;
- one lane;
- a 32-byte output.

The hashing API is isolated in `services/server/src/password.ts`. Route code
must not call the Argon2 package directly. The encoded hash records its
algorithm and parameters, and `passwordHashNeedsUpgrade` identifies a
credential that should be rehashed after a successful login.

Passwords permit spaces and Unicode without composition rules. New passwords
must contain 15 to 256 Unicode code points and no more than 1,024 UTF-8 bytes.
They are never truncated or normalized.

Password login is available at `POST /v1/auth/password/login`. Invitation
inspection and redemption use `POST /v1/auth/password/invitation` and
`POST /v1/auth/password/signup`. All three require an exact same-origin
`Origin` header. Successful login and signup issue the same HTTP-only,
same-site session cookie used by external providers.

Password recovery uses `POST /v1/auth/password/recovery` to request a link and
`POST /v1/auth/password/reset` to redeem it. The request endpoint always
returns the same accepted response for known and unknown addresses. It sends
the response before waiting for the provider request so network timing does not
turn Resend latency into an account-enumeration signal. Delivery failures are
audited for operators but are not returned to the unauthenticated caller.

Reset redemption replaces the password, increments the account session epoch,
revokes every existing session, consumes the challenge, and creates the current
browser session in one database transaction. An existing reset link remains
redeemable if email delivery is paused, but not if the password-authentication
kill switch is disabled.

## Invitations and challenges

Invitations are bound to one normalized email address. At most one unrevoked,
unaccepted invitation may exist for an address. Reissuing an invitation must
revoke the previous row before inserting its replacement.

Authentication challenges contain only a SHA-256 digest of a random
256-bit token. The plaintext token is returned once to the delivery boundary
and is never persisted or logged. Challenge redemption must use one
transactional statement that marks an unexpired, unconsumed challenge as
consumed and returns it. A read followed by a separate update is not safe.

One active challenge per purpose and normalized email prevents unbounded
parallel reset or verification links. Creating a replacement must invalidate
the previous challenge first. Expired, consumed, and invalidated rows can be
retained briefly for security metrics and then deleted by maintenance.

Invitation links put the token in the URL fragment:
`/signup#invitation=<token>`. Fragments are not sent in HTTP request targets or
referrers. The portal removes the fragment from browser history immediately,
then submits the token in a same-origin JSON request. Neither application logs
nor database rows may contain the plaintext token.

Password reset links use the same boundary:
`/reset-password#reset=<token>`. The challenge expires after one hour.
Requesting another link invalidates the previous active challenge before
creating its replacement. Resend idempotency keys contain only the challenge
ID, never the token.

## Registration and kill switches

`MDBASE_CONNECT_REGISTRATION` supplies the fail-safe deployment default:
`closed`, `invite`, or `open`. If `authentication_settings` has no row, the
server uses that value with password authentication and email delivery
disabled.

An audited database setting can override the default without a deployment.
Updates use an expected revision, so concurrent operators cannot silently
overwrite one another. Every successful revision is copied to
`authentication_settings_history` with its actor and reason.

The policy is read on authentication-sensitive requests. This is intentionally
uncached for the private beta so a kill switch reaches every server instance
as soon as PostgreSQL commits it. If authentication volume later warrants a
cache, invalidation must use PostgreSQL notifications or a similarly shared
mechanism; an instance-local TTL alone must not weaken emergency shutdown.

Password registration currently supports `invite` mode only. `open` continues
to govern configured external providers, but it does not advertise password
signup: public password registration needs a separate email-verification flow.
This prevents an operator setting from silently creating unverified
email/password accounts.

## Abuse controls

Authentication limits use PostgreSQL-backed buckets because production runs
multiple server instances. Bucket keys must be keyed digests, never raw email
addresses or IP addresses and never unkeyed hashes of low-entropy identifiers.
Separate scopes cover normalized email, source network, account, and global
send volume.

Recovery requests allow three attempts per normalized address and ten per
source network per hour. Reset redemption is separately limited by token and
source network. All scopes also consume the shared global authentication
limit. The unauthenticated HTTP response remains generic until a limit is
crossed.

The application will own limit duration, escalation, and cleanup policy. The
database table owns only the shared counter state. This lets the beta use
PostgreSQL without permanently coupling the policy to it; a later distributed
rate-limit service can implement the same interface.

Set `MDBASE_CONNECT_AUTH_RATE_LIMIT_SECRET` to a stable random value of at least
32 bytes on every server instance. Rotating it resets effective buckets and
must therefore be treated as an intentional security operation. Raw email
addresses, source IPs, and invitation tokens never appear in the bucket table.

## Sessions and suspension

Each account and session has an account session epoch. Sign-out-everywhere and
credential recovery increment the account epoch; sessions from older epochs
then fail without a bulk delete. Individual sessions have a revocation time,
and accounts have a suspension time. Authentication checks must require:

- no account suspension;
- no session revocation;
- an unexpired session;
- matching account and session epochs.

`last_seen_at` is for user-facing session inspection. It should be updated at a
coarse interval rather than on every request to avoid a write hotspot.

Authenticated browser sessions are listed at `GET /v1/account/sessions`.
`DELETE /v1/account/sessions/:sessionId` revokes one owned session, while
`POST /v1/account/sessions/revoke-others` preserves the current browser and
revokes the rest. Mutations require the exact Connect origin. Session rows
store a short browser/platform label for recognition; they do not store the
source IP or raw user-agent string. `last_seen_at` is touched at most once per
five minutes.

## Deployment

Authentication schema changes are additive. Render applies them through the
existing Connect pre-deploy migration before new application instances start.
Old application builds ignore the added tables and columns, which preserves the
release rollback window. Feature settings remain disabled until staging has
completed invitation, password, replay, expiry, concurrency, and provider
outage tests.

Password signup also requires
`MDBASE_CONNECT_TERMS_URL` and `MDBASE_CONNECT_PRIVACY_URL`. These URLs identify
the exact documents represented by the database policy versions. Both must use
HTTPS outside loopback development.

Password recovery additionally requires
`MDBASE_CONNECT_RESEND_API_KEY` and `MDBASE_CONNECT_EMAIL_FROM` on the Connect
runtime and `email_delivery_enabled` in the audited database policy. The portal
does not advertise recovery unless the shared rate limiter, password
authentication, email-delivery policy, and runtime transport are all active.

## Instance administration

The server image contains a generic database-backed operator command. It is
not an HTTP administration API and should run only in an authenticated
operator shell or one-shot job with `DATABASE_URL`. The complete command,
account-suspension, retry, and audit semantics are documented in
[`instance-administration.md`](./instance-administration.md).

Inspect the effective policy:

```bash
node services/server/dist/auth-admin-cli.js policy show
```

Create the first audited policy revision:

```bash
node services/server/dist/auth-admin-cli.js policy update \
  --expected-revision 0 \
  --registration invite \
  --password-auth enabled \
  --terms-version 2026-07-25 \
  --privacy-version 2026-07-25 \
  --actor operator:example \
  --reason "Enable private beta invitations"
```

Create an invitation:

```bash
node services/server/dist/auth-admin-cli.js invite create \
  --email person@example.com \
  --actor operator:example \
  --reason "Approved private beta participant"
```

To deliver the generated link through Resend in the same operation, configure
`MDBASE_CONNECT_RESEND_API_KEY` and `MDBASE_CONNECT_EMAIL_FROM`, enable
`email-delivery` in the audited policy, and add `--send-email enabled`. The
transport sends both plain-text and HTML versions and uses
`invitation/<invitation-id>` as Resend's idempotency key. If delivery fails,
the command exits with status 2 and still writes structured sensitive output
containing the active invitation URL, a provider error code, and whether the
failure is retryable.

Commands emit structured JSON. Policy changes use an expected revision so a
stale operator cannot overwrite a concurrent change. Invitation output is
sensitive: its token and URL appear once on standard output, while the database
stores only the digest. Deployment-specific wrappers, recipient lists, and
email-provider credentials belong in the operator's private infrastructure
repository.
