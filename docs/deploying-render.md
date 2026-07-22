# Private Render deployment

The Render Blueprint provisions three public services in Singapore:

- `mdbase-connect`, the account/control plane and transient encrypted relay;
- `mdbase-connect-hosted-provider`, the Rust hosted data plane at
  `sync.mdbase.dev`.
- `mdbase-mcp`, the remote MCP resource and OAuth server at
  `mcp.mdbase.dev`.

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

Google sign-in can be enabled alongside GitHub after creating the production
web client described in [Google authentication](./google-auth.md). Set both
`MDBASE_CONNECT_GOOGLE_CLIENT_ID` and, once known,
`MDBASE_CONNECT_ALLOWED_GOOGLE_SUBJECTS` while registration remains closed. An
empty Google allowlist rejects all Google accounts and logs the verified
subject needed to bootstrap the first invitation. Leaving both unset keeps the
existing GitHub-only preview unchanged.

The Blueprint generates the provider internal token, provider master key, and
MCP master key. Do not
replace the master key on an existing provider database: startup deliberately
fails if it cannot decrypt the durable key check. Key rotation must rewrap every
collection data key transactionally before the old key is retired.

Do not replace `MDBASE_MCP_MASTER_KEY` on an existing MCP database either.
Current gateway credentials are encrypted under that value; changing it forces
every host connection and collection grant to be authorized again.

Both databases deny public network connections. The hosted database uses paid
PostgreSQL 18 with storage autoscaling and point-in-time recovery. Automatic
deploys wait for GitHub checks, and both services use `/ready` as a database-aware
health check.

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
4. Add one receive-only and one writable mirror. Verify config, type resources,
   rename identity, conflict persistence, explicit resolution, token rotation,
   and revocation.
5. Inspect control-plane PostgreSQL and confirm it contains hosted metadata but
   no record payloads, hashes, frontmatter, bodies, or local paths.
6. Trigger a Render logical export, restore it into a separate database, start a
   provider with the same master key, and compare collection heads and complete
   snapshots. Record recovery time and the tested recovery point.
7. Run an external uptime check against both `/ready` endpoints and alert on
   sustained 5xx responses or database exhaustion.

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

The relay still coordinates live WebSockets and in-flight requests in process,
so keep the control plane at one instance until relay routing moves to shared
infrastructure. Hosted data-plane scaling does not change that constraint.

Provider logs include request IDs, routes, statuses, durations, and internal
errors through structured tracing. They must never log authorization headers,
mutation bodies, frontmatter values, query source, decrypted Markdown, or the
master key. Rotate/revoke a suspected replica or grant immediately; rotate the
internal control-plane credential on both services together.
