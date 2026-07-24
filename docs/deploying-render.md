# Private Render deployment

The Render Blueprint provisions three public services and one private service
in Singapore:

- `mdbase-connect`, the account/control plane and transient encrypted relay;
- `mdbase-connect-hosted-provider`, the Rust hosted data plane at
  `sync.mdbase.dev`.
- `mdbase-mcp`, the remote MCP resource and OAuth server at
  `mcp.mdbase.dev`.
- `mdbase-connect-relay-broker`, a private Core NATS request/reply transport.

The broker keeps authenticated NATS traffic on port 4222 and exposes NATS's
HTTP monitoring server on Render's `PORT` solely for platform health checks.
Render's port discovery also sends a delayed HTTP `HEAD` request directly to
every non-HTTP listener. The broker entrypoint filters only that exact loopback
discovery diagnostic from NATS output; all other broker warnings and errors
remain visible.

Each stateful boundary has its own paid, private PostgreSQL database. Hosted record
payloads never pass through or persist in the control-plane database. The data
plane database stores encrypted canonical records and change payloads; record
paths use keyed lookup tokens. Render-generated 256-bit secrets bind the two
services and protect the provider's wrapped per-collection data keys. The MCP
database stores OAuth metadata plus encrypted Connect tokens and private grant
keys; it never stores collection records or operation results.

## Before creating the Blueprint

Create a GitHub OAuth app with:

- Homepage: `https://connect.mdbase.dev`
- Callback: `https://connect.mdbase.dev/auth/github/callback`
- Device flow: disabled

Keep the client secret out of the repository. The private-preview allowlist
uses immutable numeric GitHub account IDs rather than usernames.

The hosted container and CI intentionally build against the pinned, published
`mdbase-rs` revision in `deploy/docker/mdbase-rs-revision`. Update that SHA only after
running its conformance suite and `pnpm e2e:provider:stress` against the new
revision. Regenerate `deploy/docker/Cargo.lock.hosted-provider` against that
clean revision at the same time. The repository-root lock remains the local
v0.3 development lock for the intentionally in-progress sibling checkout.

## Create or update the services

In Render, create a Blueprint from `mdbase-dev/mdbase-connect` and
`render.yaml`. On first creation, provide:

- `MDBASE_CONNECT_GITHUB_CLIENT_ID`
- `MDBASE_CONNECT_GITHUB_CLIENT_SECRET`
- `MDBASE_CONNECT_ALLOWED_GITHUB_USER_IDS`
- `MDBASE_CONNECT_VAPID_SUBJECT`
- `MDBASE_CONNECT_VAPID_PUBLIC_KEY`
- `MDBASE_CONNECT_VAPID_PRIVATE_KEY`
- `MDBASE_CONNECT_WEBHOOK_SIGNING_KEY_ID`
- `MDBASE_CONNECT_WEBHOOK_SIGNING_PRIVATE_KEY`

Generate the VAPID keypair once with a standards-compliant Web Push tool. Keep
the private key secret and retain the pair across deployments; replacing it
invalidates existing browser subscriptions.

Generate a stable Ed25519 webhook-signing key and a human-readable rotation ID.
Keep the private key secret. During a rotation, put the prior public JWK in
`MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON` until every delivery made
before the rotation has expired. Webhook consumers discover the current and
retained public keys at `/v1/notifications/webhook-signing-keys`.

Connect-managed native delivery is off by default. To enable it, set
`MDBASE_CONNECT_FCM_ENABLED=1` and provide
`MDBASE_CONNECT_FCM_CREDENTIALS_JSON`, or configure Google Application Default
Credentials in the service environment. Grant that sender identity only
`cloudmessaging.messages.create` in each participating application's Firebase
project. Do not upload an application's APNs key to Connect; the application
owner uploads it directly to Firebase. See
[Runtime-backed notifications](./notifications.md) for the managed-sender
security tradeoff and the recommended signed-webhook boundary for third-party
applications.

Google sign-in can be enabled alongside GitHub after creating the production
web client described in [Google authentication](./google-auth.md). Set both
`MDBASE_CONNECT_GOOGLE_CLIENT_ID` and, once known,
`MDBASE_CONNECT_ALLOWED_GOOGLE_SUBJECTS` while registration remains closed. An
empty Google allowlist rejects all Google accounts and logs the verified
subject needed to bootstrap the first invitation. Leaving both unset keeps the
existing GitHub-only preview unchanged.

The Blueprint generates the provider internal token, provider master key, MCP
master key, and relay broker token. The broker has no public endpoint and runs
without JetStream or a persistent disk. Do not
replace the master key on an existing provider database: startup deliberately
fails if it cannot decrypt the durable key check. Key rotation must rewrap every
collection data key transactionally before the old key is retired.

Do not replace `MDBASE_MCP_MASTER_KEY` on an existing MCP database either.
Current gateway credentials are encrypted under that value; changing it forces
every host connection and collection grant to be authorized again.

All databases deny public network connections. The hosted database uses paid
PostgreSQL 18 with storage autoscaling and point-in-time recovery. Automatic
deploys wait for GitHub checks. Public services use `/ready`; the control-plane
readiness check verifies PostgreSQL, the hosted provider, and NATS. Render
applies a TCP health check to the private broker.

## Domains

Attach and verify both DNS names before testing browser OAuth:

- `connect.mdbase.dev` → control-plane Render hostname
- `sync.mdbase.dev` → hosted-provider Render hostname
- `mcp.mdbase.dev` → MCP gateway Render hostname

Render terminates TLS. The control plane refuses a non-HTTPS public origin, and
the provider binds each browser capability to the application's exact manifest
origin. This binding is stored with the capability, so applications do not need
to be added to a deployment-wide origin list. CLI mirrors have no `Origin`
header and authenticate with their own collection-scoped replica credential.

## Acceptance check

Before any invitation:

1. Confirm `/health` and `/ready` on all three services.
2. Sign in through GitHub and create a hosted mdbase collection.
3. Authorize the current `mdbase-editor` build and perform create, read, query,
   update, rename, and delete operations.
4. Enroll one receive-only and one writable mirror through browser approval.
   Verify device-local credentials, config and type resources, rename identity,
   record-local conflict persistence, explicit resolution, automatic token
   renewal, status reporting, and revocation.
5. Inspect control-plane PostgreSQL and confirm it contains hosted metadata but
   no record payloads, hashes, frontmatter, bodies, or local paths.
6. Trigger a Render logical export, restore it into a separate database, start a
   provider with the same master key, and compare collection heads and complete
   snapshots. Record recovery time and the tested recovery point.
7. Run an external uptime check against both `/ready` endpoints and alert on
   sustained 5xx responses or database exhaustion.
8. Register an installed PWA for a manifest notification criterion, perform a
   matching hosted mutation while the app is closed, receive the push, and
   confirm the control-plane database contains only opaque signal metadata.
9. Send one signed notification webhook to a verifier using
   `@mdbase/connect-webhooks`; confirm a modified body and an expired timestamp
   are rejected, retry the same delivery ID, and confirm the consumer processes
   it only once.
10. When managed FCM is enabled, register one Android and one iOS installation,
    rotate an FCM token, and confirm only the current token receives a
    content-free wake-up notification.

Render provides continuous PITR for paid PostgreSQL. PITR is not a substitute
for the restore drill: recovery creates another database and the service must be
deliberately repointed only after snapshot verification.

## Scaling and incident boundaries

The hosted provider is horizontally correct: PostgreSQL row locks order writes,
working sets are disposable and head-checked, and the E2E suite races two
processes on one revision. Start with one instance while traffic is private;
scale after repeating the 10,000-record budget in-region.

The provider also compacts each collection to the most recent 10,000 changes
every five minutes. A replica behind that cursor automatically performs a
snapshot reset; it does not prevent retention indefinitely. Tune
`MDBASE_CONNECT_HOSTED_RETAIN_CHANGES` only after measuring database growth and
reset frequency in the production region.

The control plane is horizontally correct. PostgreSQL allocates a generation
for every connector session, and Core NATS routes transient requests to the
instance holding that exact WebSocket. A newer connection fences and closes
older sessions across instances. Policy snapshots use the same route, while
the connector remains the final authorization boundary.

The Blueprint starts with one broker instance. That is enough to scale the
control plane but makes new relay operations dependent on that broker. For
higher availability, run three clustered NATS private services and provide all
three addresses in `MDBASE_CONNECT_RELAY_NATS_URL`. Keep JetStream disabled:
relay request and response bodies must remain transient.

Provider logs include request IDs, routes, statuses, durations, and internal
errors through structured tracing. They must never log authorization headers,
mutation bodies, frontmatter values, query source, decrypted Markdown, or the
master key. Rotate/revoke a suspected replica or grant immediately; rotate the
internal control-plane credential on both services together.
