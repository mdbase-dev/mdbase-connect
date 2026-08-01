# mdbase connect

> [!IMPORTANT]
> **Invite-only beta:** The managed mdbase connect cloud service is currently
> available by invitation only. Access to `connect.mdbase.dev`, including
> hosted collections and the managed connection service, requires beta access.
> If you have been invited, follow the access instructions you received.

mdbase connect lets you use the applications you choose with the Markdown data
you control. An application gets access to one collection only after you
approve the exact actions it can perform, and you can pause or revoke that
access at any time.

Your collection can stay in a folder on your computer or be hosted by mdbase
with an optional local Markdown mirror. Either way, it remains a standard
[mdbase](https://mdbase.dev) collection rather than being moved into an
application-specific database.

## What you can do

- Connect websites and native applications to a local or hosted collection.
- Review concrete permissions such as reading, querying, creating, or updating
  records before granting access.
- Keep local collection folders private and make remote access available
  without opening an inbound port on your computer.
- Work directly on the same computer when possible, with automatic fallback to
  an encrypted relay when needed.
- Pause an application or revoke its access immediately.
- Use your collections from MCP clients such as Claude and ChatGPT.
- Mirror a hosted collection to a local folder for Markdown-based tools and
  backups.

## How it works

### Collections on your computer

The mdbase connect desktop app registers your collection and runs a small
background connector. Applications use a direct local connection when they
are on the same computer. From elsewhere, requests travel through the managed
relay, while the connector on your computer remains the final authority for
every operation.

Your collection path is not sent to the cloud service, and you do not need to
expose your computer to incoming internet connections.

### Hosted collections

Hosted collections keep their authoritative Markdown with mdbase. You can
optionally mirror a hosted collection to a folder on your computer and continue
using file-based tools alongside connected applications.

Applications use the same approval model for local and hosted collections, so
moving where a collection lives does not give an application broader access.

## Getting started during the beta

There is no public signup for the managed cloud service while it is in
invite-only beta.

If you have beta access:

1. Follow your invitation to create or access your mdbase connect account.
2. Install the desktop build provided for your platform.
3. Open the desktop app and pair your computer.
4. Add an existing mdbase collection or create a hosted collection.
5. In a compatible application, choose **Connect collection** and review the
   requested access before approving it.

The desktop app is the main place to manage collections, local mirrors,
connected applications, and access. The account portal is available for
pairing, account recovery, and remote revocation.

## Connect an MCP client

The managed MCP endpoint is:

```text
https://mcp.mdbase.dev/mcp
```

Add it as a remote or custom MCP connector in an OAuth-capable client. The
first connection asks you to choose a collection and approve its access.
Additional collections receive independent grants, so connecting one does not
expose the others.

See the [MCP gateway guide](docs/mcp-gateway.md) for supported tools and the
gateway's trust boundary.

## Build an application

The `@mdbase-dev/connect` SDK gives browser and native applications an authorized,
collection-scoped client:

```bash
pnpm add @mdbase-dev/connect
```

Start with the [five-minute quickstart](https://mdbase.dev/sdk/quickstart/) or
read the complete [Connect SDK guide](https://mdbase.dev/sdk/). The SDK supports
authorization with PKCE, direct and relayed operations, hosted replication,
change delivery, notifications, and portable downloaded applications.

Applications declare their data contracts and requested capabilities. If a
collection needs a declared contract, mdbase connect shows that change during
approval and installs it as one verified transaction. This does not give the
application general permission to manage types or schemas.

## Security and privacy

mdbase connect is designed so that granting useful access does not mean handing
an application an entire folder or account:

- Each grant is tied to one application, one collection, and an explicit set of
  operations.
- The local connector enforces access at the computer that owns a local
  collection.
- Local collection paths never leave the computer.
- Browser-to-connector relay payloads are end-to-end encrypted. The managed
  relay can see routing metadata, operation timing, and payload sizes, but not
  record contents or operation results.
- Hosted Markdown is encrypted at rest using per-collection data keys.
- Pausing or revoking a grant is enforced immediately.

The MCP gateway is an authorized application endpoint: it decrypts responses
in memory so it can return them to the MCP client, but does not persist record
payloads or operation results.

For the detailed trust model, see
[Architecture](docs/architecture.md), [Encryption](docs/encryption.md), and
[Hosted collections](docs/hosted-provider.md). Security assumptions, abuse
cases, and prerelease residual risks are collected in the
[Threat model](docs/threat-model.md). Please use the private reporting process
in the [Security policy](SECURITY.md) for suspected vulnerabilities.

## Command line

The desktop app includes the unified `mdbase` CLI and background daemon. Direct
collection commands are top-level; identity, authorization, mirroring, and
daemon administration live under `mdbase connect`.

```bash
mdbase --root /path/to/notes query --types task
mdbase connect collection list
mdbase connect hosted list
mdbase connect mirror add <collection-id> /path/to/mirror
mdbase connect status
```

Human-readable output is the default. Connect administration commands support
`--json` for automation. See the [unified CLI guide](docs/unified-cli.md) for
the full command model.

## Self-hosting

mdbase connect is open-source, and advanced operators can run the control
plane, relay, hosted collection provider, and MCP gateway themselves.
Self-hosters are responsible for authentication, TLS, signing, upgrades,
monitoring, backups, and incident response.

Use an immutable beta release tag rather than `main`, and follow the
[production self-hosting guide](docs/self-hosting.md).

## Contributing

This repository contains the desktop app, CLI and connector, browser SDK,
managed-service control plane and relay, hosted collection provider, MCP
gateway, and shared protocols.

Development requires a Rust toolchain, Node.js 24 LTS, and pnpm 11.15.1.

```bash
pnpm install
cargo test --workspace
pnpm build
pnpm typecheck
pnpm test
```

The private `mdbase-connect-testbed-adapter` crate drives the production
notification catalog, authorization hook, action provider, runtime, and store
through the spec-owned `runtime.application-execution` black-box scenario. It
is verification plumbing only and is never published as a Connect API.

The end-to-end suites cover local authorization, the encrypted relay, hosted
replication, and the production hosted provider:

```bash
pnpm e2e
pnpm e2e:relay
pnpm e2e:sync
pnpm e2e:provider
```

To run the local development environment:

```bash
cp .env.example .env
pnpm dev:environment:up
pnpm dev:desktop:fresh
```

See [Testing](docs/testing-environment.md), [Maintainability](docs/maintainability.md),
[Releasing](docs/releasing.md), and [Production self-hosting](docs/self-hosting.md)
for the complete workflows.

## License

[MIT](LICENSE)
