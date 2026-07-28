# mdbase connect

mdbase connect lets user-authorized websites and native applications operate
on a user's local or mdbase-hosted [mdbase](https://mdbase.dev) collections.
Local collection folders are never exposed directly to the internet; hosted
collections keep their authoritative Markdown on mdbase with optional mirrors.

Build an application with the task-oriented
[Connect SDK guide](https://mdbase.dev/sdk/), or start with the
[five-minute quickstart](https://mdbase.dev/sdk/quickstart/).

Applications bundle declarations that can include transactional type packs.
When a selected collection is missing a required contract, its local or hosted
authority installs the contract, implementing types, and referenced schemas as
one verified change during approval. It pins the resulting contract and
implementation digests before creating the grant. Setup does not grant the
application general type-management access.

This is a functional beta foundation. The tested path covers creating a local
collection, pairing an outbound-only connector, discovering an independent web
app, approving exact operations locally or from the authenticated account
portal, reading and writing records directly on the same computer or through
the encrypted relay, discovering schemas and
application contract metadata, limiting applications to records belonging to
their declared contracts, renewing browser authorization, receiving filesystem
changes, rejecting stale revisions, pausing access, and immediately enforcing
revocation. Browser-to-connector operation payloads use grant-bound end-to-end
encryption; the relay sees routing metadata and ciphertext.

Hosted collections are generic mdbase collections. Domain-specific contracts,
models, and interfaces live in their owning applications.

## What is here

- `crates/connect-agent`: the embeddable Rust daemon library for local policy
  enforcement, filesystem watching, hosted mirrors, runtime execution, the
  hardened browser loopback API, and the outbound relay.
- `crates/connect-runtime`: the small Connect adapter that compiles exact grant
  criteria into provider-neutral `mdbase-runtime` workflows.
- `crates/connect-cli`: the final `mdbase` executable. It combines the
  transport-neutral collection commands from `mdbase-rs` with Connect
  administration and the foreground/service-managed daemon entry point.
- `crates/connect-mirror`: the durable Rust filesystem mirror state machine.
- `apps/desktop`: an Electron client of the same daemon for local and hosted
  collections, application access, browser pairing, activity, tray operation,
  and launch-at-login.
- `services/server`: Fastify control plane and transient, horizontally scalable
  relay backed by PostgreSQL and optional Core NATS request/reply. It also owns
  Web Push installations and a durable, privacy-minimal delivery outbox.
- `services/mcp`: separately deployed remote MCP gateway for Claude, ChatGPT,
  and other OAuth-capable hosts. It maps one host connection to independently
  approved collection grants and keeps its credentials in a separate database.
- `crates/connect-hosted-provider`: encrypted PostgreSQL authority for hosted
  collections, with direct app operations and the versioned sync data plane.
- `apps/portal`: deliberately small account, computer management, secure
  pairing, remote approval, and emergency grant-review surface. Routine
  collection and mirror configuration stays in the desktop controller, and
  there is no developer portal.
- `packages/client`: browser SDK using authorization code or portable device
  authorization with PKCE, plus a dependency-free CDN/SRI browser build.
- `packages/protocol`: shared versioned web/relay contracts.
- `packages/devkit`: canonical artifact validation and an explicit frontend
  sandbox over the same typed collection-client boundary.
- `packages/sync`: the TypeScript hosted-replication client and reference
  implementation used by SDK consumers; the desktop does not run a second
  mirror owner.

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
pnpm e2e:relay
pnpm e2e:sync
pnpm e2e:provider
```

`pnpm e2e` launches an ephemeral control plane, a real connector daemon, a test
web application, and a real mdbase collection. It completes OAuth/PKCE,
approves access through the local control API, performs a 1,000-record query
through the browser SDK's direct route, discovers a real JSON Schema and
example application contract, proves that private records outside the contract cannot be
read or queried, rotates authorization credentials, relays create/read/update
operations, verifies change delivery and revision conflicts, exercises the
local pause switch, revokes the grant, and confirms that access and renewal are
rejected. It also crosses the JavaScript/Rust encryption boundary and verifies
tamper and plaintext-downgrade rejection. It also proves that an identical
direct-to-relay retry returns a durable encrypted receipt without executing a
mutation twice.

`pnpm e2e:relay` runs two control-plane instances against disposable real
PostgreSQL and Core NATS containers. It verifies cross-instance operations and
policy delivery, generation-fenced socket replacement, concurrent and large
payloads, fail-closed broker readiness, subscription recovery after a broker
restart, connector reconnects, and the absence of payloads in control-plane
audit storage.

`pnpm e2e:sync` exercises the generic hosted replication slice through the real
HTTP server, including offline writes, two-client convergence, idempotency,
conflicts, a receive-only Markdown mirror, cursor reset,
and revocation.

`pnpm e2e:provider` runs the production Rust provider against disposable
PostgreSQL 18. It includes a real Chromium portal flow, direct OAuth SDK
operations, encrypted-at-rest checks, two provider instances racing one write,
pinned snapshots, writable filesystem mirroring, durable retry receipts,
an exact hosted-to-local authority handoff through the real CLI and portal,
authority fencing, proof rejection, completion retry, cancellation recovery,
compaction, restart recovery, logical backup restoration into a fresh database,
credential rotation, quotas, ciphertext tamper detection, and a private mutation
flowing through the hosted runtime into an opaque notification callback.
`pnpm e2e:provider:stress` repeats the path with 10,000 records and enforces the
documented latency budgets.

To produce and inspect a local desktop bundle:

```bash
pnpm --filter @mdbase/connect-desktop package
```

This builds the release Rust daemon/CLI, embeds it beside the Electron application,
and fails if either the application archive or connector binary is absent. See
[`docs/releasing.md`](docs/releasing.md) for signing and beta-release gates.
Installed builds expose one signed update experience: notarized macOS releases
stage automatically, while Windows Store and Linux packages hand replacement
back to their platform trust channel. See
[`docs/desktop-updates.md`](docs/desktop-updates.md) for rollout, daemon handoff,
and recovery behavior.

## Use the CLI and daemon

`mdbase` is the one human/machine CLI. Direct collection commands live at the
top level; identity, authorization, replication, and daemon lifecycle live
under `mdbase connect`. The desktop is an optional peer of that daemon; closing
it does not stop synchronization, relay access, or local collection watching.

```bash
mdbase --root /path/to/notes query --types task
mdbase connect daemon install
mdbase connect login
mdbase connect collection list
mdbase connect hosted list
mdbase connect mirror add <collection-id> /path/to/mirror
mdbase connect status
```

Human-readable output is the default. Add `--json` for the stable automation
contract on Connect administration commands; collection data commands always
emit their canonical portable JSON envelope. Use `mdbase --collection <uuid>`
to route a portable data command through the daemon. `mdbase --timings ...`
adds payload-free command timing JSON on stderr, and `mdbase profile
engine|connect` runs repeatable built-in workloads. See
[`docs/unified-cli.md`](docs/unified-cli.md) and
[`docs/cli-daemon.md`](docs/cli-daemon.md) for the command model, process
boundary, state/secrets contract, and failure model.

To run the desktop controller locally:

```bash
pnpm --filter @mdbase/connect-desktop start
```

When a filesystem copy has the same Connect identity as its registered
original, use the desktop's **Register copy** action or the explicit local
command:

```bash
mdbase connect collection add-copy /path/to/copied-collection
```

The command refuses to rewrite the registered original. It changes only the
copy's `x-mdbase-connect.collection_id`, then registers the copy as an
independent collection.

## Run the development stack

```bash
cp .env.example .env
pnpm dev:environment:up
```

Open the desktop app, enter `http://127.0.0.1:8787` when prompted, and choose
**Pair this computer**. Sign in and approve the pairing in the browser; no
connector token is shown or copied. See
[`docs/self-hosting.md`](docs/self-hosting.md) for the separate production
self-hosting path.

Use `pnpm dev:desktop:fresh` to launch Electron with a clean,
development-only profile that cannot read the normal desktop configuration.
`pnpm e2e:container` verifies the packaged server as a black box, while
`pnpm e2e:desktop:container` runs the native Electron controller and real Rust
agent against a disposable instance of that image. See
[`docs/testing-environment.md`](docs/testing-environment.md) for isolation,
interactive usage, and the reusable consumer-test lifecycle.

The software behind the managed mdbase connect service is this repository.
Production service configuration, secrets, capacity choices, and operational
runbooks are maintained separately from the open-source product. Public
deployments should use immutable beta release tags rather than `main`. See
[`docs/releasing.md`](docs/releasing.md) for the version policy and
[`docs/google-auth.md`](docs/google-auth.md) for Google sign-in setup.

The hosted MCP endpoint is `https://mcp.mdbase.dev/mcp`; users add that URL as
a remote/custom connector and authorize their first collection through mdbase
connect. The `add_connection` tool creates a short-lived approval link for each
additional collection, and `reconnect_collection` renews one existing
connection with its collection preselected. See
[`docs/mcp-gateway.md`](docs/mcp-gateway.md) for the
trust boundary, development workflow, tools, and production checklist.

## Security status

The local connector is the final authorization boundary: the server cannot
expand a cached grant, collection paths never leave the machine, connector
tokens are stored encrypted by Electron, and cloud tokens are hashed at rest.
New SDK authorizations require encrypted relay protocol 1 by default. Operation
inputs and results remain ciphertext at the control plane; identifiers,
operation names, timing, and sizes remain visible.

The MCP gateway is an authorized application endpoint, not part of the blind
control plane. It decrypts local relay responses in memory so it can return
them to the MCP host. It does not persist record payloads, local filesystem
paths, or operation results. Its upstream tokens and P-256 private keys are
encrypted under a deployment master key in a separate database.

The same envelopes protect direct loopback operations. The connector requires
the grant's exact browser origin, an exact loopback `Host`, non-simple JSON, and
application-key proof on every operation; its desktop administration socket is
not exposed to browsers.

Production deployments can use GitHub OAuth and Google Identity Services with
allowlists of immutable provider subjects. The server refuses development
authentication on non-loopback origins, and development email login must never
be exposed publicly. Hosted Markdown is encrypted under per-collection data
keys; record paths are represented in PostgreSQL by keyed lookup tokens. Public
registration, a live restore drill, signed desktop releases, and
abuse-response operations remain release gates.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/mvp.md`](docs/mvp.md), [`docs/sync.md`](docs/sync.md), and
[`docs/encryption.md`](docs/encryption.md),
[`docs/notifications.md`](docs/notifications.md), and
[`docs/hosted-provider.md`](docs/hosted-provider.md) for the trust model, acceptance path,
implemented protocol boundaries, and remaining replication and encryption
work.
