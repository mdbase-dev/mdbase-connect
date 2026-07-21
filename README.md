# mdbase connect

mdbase connect lets user-authorized websites and native applications operate
on a user's local or mdbase-hosted [mdbase](https://mdbase.dev) collections.
Local collection folders are never exposed directly to the internet; hosted
collections keep their authoritative Markdown on mdbase with optional mirrors.

Applications can declare portable type provisions in their manifest.
When a selected collection is missing a required contract, its local or hosted
authority installs the declared type during approval, verifies the resulting
contract scope, and creates the grant afterward. Setup does not grant the
application general type-management access.

This is a functional private-beta foundation. The tested path covers creating a local
collection, pairing an outbound-only connector, discovering an independent web
app, approving exact operations locally or from the authenticated account
portal, reading and writing records through the relay, discovering schemas and
TaskNotes contract metadata, limiting applications to records belonging to
their declared contracts, renewing browser authorization, receiving filesystem
changes, rejecting stale revisions, pausing access, and immediately enforcing
revocation. Browser-to-connector operation payloads use grant-bound end-to-end
encryption; the relay sees routing metadata and ciphertext.

Hosted collections are generic mdbase collections. TaskNotes is one reference
application and contract adapter—not a collection kind or platform default.

## What is here

- `crates/connect-agent`: Rust background connector, local policy enforcement,
  filesystem watching, and outbound WebSocket relay.
- `crates/connect-cli`: local administration and operation CLI.
- `apps/desktop`: Electron controller for collection registration, application
  metadata and availability, application access, browser pairing, local
  activity, tray operation, and launch-at-login.
- `services/server`: Fastify control plane and transient relay backed by
  PostgreSQL.
- `crates/connect-hosted-provider`: encrypted PostgreSQL authority for hosted
  collections, with direct app operations and the versioned sync data plane.
- `apps/portal`: deliberately small account, computer management, secure
  pairing, remote approval, and grant-review surface. Routine collection
  configuration stays in the local controller, and there is no developer
  portal.
- `packages/client`: browser SDK using authorization code + PKCE.
- `packages/protocol`: shared versioned web/relay contracts.
- `packages/devkit`: canonical artifact validation and an explicit frontend
  sandbox over the same typed collection-client boundary.
- `packages/sync`: the versioned hosted-replication model, offline replica
  stores and client, HTTP transport, and receive-only or conflict-safe writable
  Markdown mirrors.
- `packages/tasknotes`: portable TaskNotes contract adapter using configurable
  field roles and generic revision-safe operations.
- `apps/tasknotes`: deliberately small reference frontend for the TaskNotes
  contract.

Collection behavior comes from the active `mdbase-rs` implementation; this
repository does not reimplement the mdbase specification. During v0.3
development the Rust workspace uses the adjacent `../mdbase-rs` checkout.

## Verify the MVP

Prerequisites are a Rust toolchain, Node 24 LTS, and pnpm 11.15.1.

```bash
pnpm install
cargo test --workspace
pnpm build
pnpm typecheck
pnpm test
pnpm e2e
pnpm e2e:sync
pnpm e2e:provider
```

`pnpm e2e` launches an ephemeral control plane, a real connector agent, a test
web application, and a real mdbase collection. It completes OAuth/PKCE,
approves access through the local control API, discovers a real JSON Schema and
TaskNotes contract, proves that private records outside the contract cannot be
read or queried, rotates authorization credentials, relays create/read/update
operations, verifies change delivery and revision conflicts, exercises the
local pause switch, revokes the grant, and confirms that access and renewal are
rejected. It also crosses the JavaScript/Rust encryption boundary and verifies
tamper, replay, and plaintext-downgrade rejection.

`pnpm e2e:sync` exercises the hosted TaskNotes vertical slice through the real
HTTP server, including offline writes, two-client convergence, idempotency,
contract discovery, conflicts, a receive-only Markdown mirror, cursor reset,
and revocation.

`pnpm e2e:provider` runs the production Rust provider against disposable
PostgreSQL 18. It includes a real Chromium portal flow, direct OAuth SDK
operations, encrypted-at-rest checks, two provider instances racing one write,
pinned snapshots, writable filesystem mirroring, durable retry receipts,
compaction, restart recovery, logical backup restoration into a fresh database,
credential rotation, quotas, and ciphertext tamper detection.
`pnpm e2e:provider:stress` repeats the path with 10,000 records and enforces the
documented latency budgets.

To produce and inspect a local desktop bundle:

```bash
pnpm --filter @mdbase/connect-desktop package
```

This builds the release Rust agent, embeds it beside the Electron application,
and fails if either the application archive or connector binary is absent. See
[`docs/releasing.md`](docs/releasing.md) for signing and beta-release gates.

To run the desktop controller locally:

```bash
pnpm --filter @mdbase/connect-desktop start
```

## Run the development stack

```bash
cp .env.example .env
docker compose up --build
```

Open the desktop app, enter `http://localhost:8787` when prompted, and choose
**Pair this computer**. Sign in and approve the pairing in the browser; no
connector token is shown or copied. See
[`docs/self-hosting.md`](docs/self-hosting.md) for important limitations.

The private hosted relay is defined by [`render.yaml`](render.yaml). See
[`docs/deploying-render.md`](docs/deploying-render.md) for the one-user Render
deployment, DNS, and verification checklist, and
[`docs/google-auth.md`](docs/google-auth.md) for Google sign-in setup.

## Security status

The local connector is the final authorization boundary: the server cannot
expand a cached grant, collection paths never leave the machine, connector
tokens are stored encrypted by Electron, and cloud tokens are hashed at rest.
New SDK authorizations require encrypted relay protocol 3 by default. Operation
inputs and results remain ciphertext at the control plane; identifiers,
operation names, timing, and sizes remain visible.

The private Render deployment can use GitHub OAuth and Google Identity Services
with allowlists of immutable provider subjects. The server refuses development
authentication on non-loopback origins, and development email login must never
be exposed publicly. Hosted Markdown is encrypted under per-collection data
keys; record paths are represented in PostgreSQL by keyed lookup tokens. Public
registration, a live Render restore drill, signed desktop releases, and
abuse-response operations remain release gates.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/mvp.md`](docs/mvp.md), [`docs/sync.md`](docs/sync.md), and
[`docs/encryption.md`](docs/encryption.md), and
[`docs/hosted-provider.md`](docs/hosted-provider.md) for the trust model, acceptance path,
implemented protocol boundaries, and remaining replication and encryption
work.
