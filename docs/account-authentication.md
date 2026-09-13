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
subject, but it cannot create another account with a verified email already
claimed for account creation. The user must sign in to that account and link the
provider from account settings instead. Account-creation claims are reserved in
the same transaction as the new account; authenticated provider linking does
not transfer them or infer ownership from matching email text.

Email normalization is deliberately conservative and versioned. Version 1
trims outer whitespace, applies Unicode NFC, lower-cases the local and domain
parts, and converts international domain names to ASCII. It does not remove
plus-tags, remove dots, or apply provider-specific alias rules. Active
normalized addresses are unique; retired identities remain available for
audit while no longer reserving the address.

## Public Google and GitHub signup

`/signup` offers the configured identity providers alongside verified
email/password registration. A provider callback for an existing identity signs
in directly. In `open` mode, a new identity instead goes to a short account
confirmation page: confirm the name and accept the current terms/privacy
versions. No account or session exists before that confirmation succeeds.
This also applies when a new person starts from `/login`, so the login button
cannot bypass signup requirements.

Google must supply a verified email. GitHub login requests only `user:email`
(no repository access); Connect reads `/user/emails` and accepts only the
verified primary email, including private addresses. An unverified or missing
primary address cannot create an account: verify it at the provider, or use
email signup. GitHub account-linking and deletion reauthentication retain their
existing identity-only scope. Provider tokens are never persisted.

The callback stores only the verified identity and the validated same-origin
return target in `external_signup_challenges`, keyed by a random token's digest.
The raw token is carried in a ten-minute HTTP-only, same-site cookie (`__Host-`
and Secure on HTTPS), not a URL or browser storage. Expired proofs are removed
when another proof is issued; consumed proofs are deleted immediately. Preview
and confirmation use exact-origin POSTs at `/v1/auth/external/signup/preview`
and `/v1/auth/external/signup`. Neither endpoint accepts a provider identity or
credential from the browser. Preview returns a non-bearer `proof_id` (the
random token's digest), which confirmation must echo alongside the HTTP-only
cookie. This binds acceptance to the displayed identity and rejects a stale
form when another tab replaces the cookie with a different provider proof.

Confirmation locks and rereads the current registration/legal policy and
atomically consumes the proof, claims the email, creates the account, verified
primary email identity and session, records legal acceptance, grants
`open_beta_v1`, schedules the welcome email, and schedules the starter
collection. Password and provider signup share the onboarding implementation.
The provider subject is transaction-locked, so independent concurrent proofs
cannot duplicate onboarding; verified-email claims prevent cross-provider or
password/provider races from creating duplicate accounts. Any failure rolls
back proof consumption and all account writes. Existing accounts are not
silently linked by email, renamed, or granted another signup allowance.

`external_public_registration` is advertised only when registration is open,
a provider is configured, current legal versions/URLs exist, and the shared
authentication limiter is configured. Unlike password signup, provider signup
does not depend on the password or email-delivery switches: the provider has
already verified the address. Welcome email remains subject to the delivery
policy. Issuance, preview and completion use separate PostgreSQL-backed rate
scopes with keyed digests (10 attempts per proof/subject, 30 per network, and
300 globally per hour). Preview does not consume completion's attempt budget.
Closing registration blocks in-flight proofs as well as new issuance.
Deconfiguring a provider also prevents its outstanding proofs being redeemed.

The additive migration `0029_external_signup.sql` must run before the new
server. Release the server and its bundled portal together; an older portal
does not understand the confirmation page. Old server builds
ignore the added table, but rolling back the server also restores its previous
external-account-creation behavior. Allowlisted bootstrap creation in closed
or invite mode is unchanged; existing external accounts are not retroactively
converted into public-signup accounts.

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
`POST /v1/auth/password/signup`. Public password registration requests,
inspects, and redeems an email-verification challenge through
`POST /v1/auth/password/signup/request`,
`POST /v1/auth/password/signup/verification`, and
`POST /v1/auth/password/signup/public`. The request may include a same-origin
`return_to`; it is carried through the verification email so account creation
can resume the original authorization or transactional flow. All authentication
mutations require an exact same-origin `Origin` header. Successful login and signup issue the
same HTTP-only, same-site session cookie used by external providers.

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

Public signup verification uses the equivalent fragment-only boundary:
`/signup#verification=<token>`. The request endpoint returns the same `202`
body whether the address is available or belongs to an existing account. Both
paths perform the same challenge write, but only available addresses receive
the link. Challenges are one-hour and single-use;
requesting another invalidates the previous challenge. Account creation,
verified email ownership, password credential, agreement acceptance, session,
entitlement, and starter-collection scheduling commit in one transaction.
Public signup assigns the permanent `open_beta_v1` profile: 1 GiB live hosted
storage, 2 GiB retained file storage, three hosted collections in total
(including the starter collection), 2 MiB per Markdown document, 250 MiB per
file, 10,000 files per collection, 10 mirror replicas per collection, and 50
application replicas per collection. Invitation-based `beta_v1` grants retain
their existing ten-collection allowance.

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

Password invitations are redeemable in both `invite` and `open` modes so a
policy transition does not strand issued invitations. Public password signup
is advertised only in `open` mode, and only when password authentication, the
shared abuse limiter, current legal documents, audited email delivery, and a
runtime email transport are all available. The server never creates an
unverified email/password account.

## Abuse controls

Authentication limits use PostgreSQL-backed buckets because production runs
multiple server instances. Bucket keys must be keyed digests, never raw email
addresses or IP addresses and never unkeyed hashes of low-entropy identifiers.
Separate scopes cover normalized email, source network, account, and global
send volume.

Recovery and public-signup requests allow three attempts per normalized
address and ten per source network per hour. Signup-verification preview and
account redemption use separate token, source-network, and global scopes so
reloading a valid link cannot consume the budget needed to create the account.
Reset and signup redemption remain independently limited by token and source
network. The unauthenticated request response remains generic until a limit is
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

## Account deletion

`DELETE /v1/account` commits the complete control-plane teardown in one database
transaction. The transaction revokes cross-account hosted replicas, records
provider collection and capability cleanup as durable work, writes the
`account.deleted` audit event, and deletes the user. A failed transaction leaves
none of those effects committed. Irreversible provider cleanup starts only after
the transaction commits and is idempotently retried until complete.

`MDBASE_CONNECT_ACCOUNT_DELETION` is the operational hold. Its only accepted
values are `enabled` and `disabled`; omitted means `enabled`. While disabled,
`GET /v1/account` reports deletion as unavailable and `DELETE /v1/account`
returns `503 account_deletion_unavailable` without changing account or provider
state. The in-process development reference authority also fails account
deletion closed because it has no durable provider-cleanup worker.

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

Password recovery and public password registration additionally require
`MDBASE_CONNECT_RESEND_API_KEY` and `MDBASE_CONNECT_EMAIL_FROM` on the Connect
runtime and `email_delivery_enabled` in the audited database policy. The portal
does not advertise either capability unless its complete dependency set is
active.

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
