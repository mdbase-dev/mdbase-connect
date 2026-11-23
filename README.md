# mdbase connect

[![What mdbase does, in two minutes](https://mdbase.dev/videos/mdbase-in-two-minutes.jpg)](https://mdbase.dev/videos/mdbase-in-two-minutes.mp4)

mdbase connect lets the applications and AI agents you choose work with your
Markdown notes without handing them your whole folder or account. Your notes
stay ordinary Markdown files with YAML frontmatter, a standard
[mdbase](https://mdbase.dev) collection, instead of moving into an
application's database. An application gets access to one collection only
after you approve the exact operations it can perform, and you can pause or
revoke that access at any time.

## What you can do

- Connect web, desktop and mobile applications, Obsidian, and MCP clients such
  as Claude and ChatGPT to a collection.
- Review concrete permissions, such as reading, querying, creating or updating
  records, before granting access.
- Sync a collection to a folder on each of your computers and keep using any
  Markdown tool alongside connected applications.
- Pause an application or revoke its access at any time.
- Read, query and write your collections from the `mdbase` command line.
- Build your own application with the `@mdbase-dev/connect` SDK.

## How it works

Every collection keeps an ordered log of changes and syncs through the mdbase
service. The log is sealed: the sync service orders and stores encrypted
changes but holds no collection keys. You choose how the collection is served
when your computers are off:

- **Cloud copy** (the default): mdbase also keeps a copy of the collection, so
  web applications and AI agents can use it while your computers are off.
- **Private**: collection keys stay on your devices and sync is end-to-end
  encrypted. Web applications and agents reach the collection through one of
  your computers, which needs to be online.

On a computer, the desktop app syncs the collection to a folder you pick and
runs a small background connector. Applications on the same computer can
connect to it directly. For a Private collection, applications elsewhere reach
it through an end-to-end encrypted relay. The folder's path is never sent to the service, and you do not need to open an
inbound port.

Applications use the same approval model whichever way a collection is served,
so changing it does not give an application broader access.

## Getting started

1. Create a free account at
   [connect.mdbase.dev](https://connect.mdbase.dev/signup).
2. Create a collection in the [editor](https://editor.mdbase.dev/), or install
   the [desktop app](https://mdbase.dev/downloads/) to sync a collection with a
   folder on your computer, including a folder of Markdown you already have.
3. In a compatible application, choose **Connect collection** and review the
   requested access before approving it.

The editor's **Connect** workspace is the main web place to manage collections,
connected applications, computers, and account sessions. The desktop app owns
folder and sync settings. The Connect portal is intentionally limited to
sign-in, pairing, recovery, and authorization transactions.

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

The mdbase plugin package bundles this endpoint with collection skills for
ChatGPT, Codex and Claude. For local testing and directory submission, see
[ChatGPT and Codex plugin](docs/chatgpt-plugin.md) and
[Claude plugin](docs/claude-plugin.md).

## Release notes

See the [changelog](CHANGELOG.md) for breaking SDK/contract changes, durable
mutation guarantees, upgrade requirements, recovery guidance, and platform
preview limitations.

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
- Access is checked against that exact grant wherever the collection is
  served: by the connector on your computer, or by the cloud copy.
- Folder paths on your computers never leave them.
- Browser-to-connector relay payloads are end-to-end encrypted. The managed
  relay can see routing metadata, operation timing, and payload sizes, but not
  record contents or operation results.
- The sync log is sealed: the service orders and stores encrypted changes but
  holds no collection keys. A cloud copy is readable by mdbase so it can serve
  applications; a Private collection is not.
- Pausing is enforced immediately, and revocation immediately disables
  Connect-issued credentials.

The MCP gateway is an authorized application endpoint: it decrypts responses
in memory so it can return them to the MCP client, but does not persist record
payloads or operation results.

For the detailed design, see the [runtime overview](runtime/README.md), its
[contracts](runtime/docs/contracts/00-overview.md), and
[Encryption](docs/encryption.md). Security assumptions, abuse
cases, and prerelease residual risks are collected in the
[Threat model](docs/threat-model.md). The source and test map for independent
review is the explicitly unaudited
[Security audit preparation package](docs/security-audit-package.md). Please
use the private reporting process in the [Security policy](SECURITY.md) for
suspected vulnerabilities.

## Command line

The desktop app includes the `mdbase` CLI and background daemon. The same
native executable is also published as a standalone headless archive for
Linux, macOS, and Windows.

```bash
mdbase status
mdbase collection add /path/to/notes
mdbase query --types task --where 'status == "open"'
mdbase read tasks/review.md
mdbase update tasks/review.md --fields '{"status": "done"}'
mdbase validate -c notes
```

Record commands work on the folder you are in, another with `-C PATH`, or a
registered collection with `-c`; they go through the daemon when it serves the
folder. Output is human-readable; `--json` prints machine-readable results. Run `mdbase --help` for the full list, and see the [headless
installation guide](docs/headless.md) for verified standalone installation,
service operation and record commands.

## Contributing

This repository contains the editor, desktop app, CLI and connector, browser
SDK, managed-service control plane and relay, hosted collection provider, MCP
gateway, and shared protocols. These products release independently even
though they share one workspace and lockfile.

See [Contributing](CONTRIBUTING.md) for change fragments, the architecture
check, generated-file rebases, and release versioning.

Development requires a Rust toolchain, Node.js 24 LTS, and pnpm 11.15.1.

```bash
pnpm install
cargo test --workspace
pnpm build
pnpm typecheck
pnpm test
```

See the [CI flake policy](docs/ci-flakes.md) for bounded, recorded per-test
retries and the retry-free nightly stress workflow.

The end-to-end suites cover the runtime daemon's request path, the encrypted
relay, and the production hosted provider:

```bash
pnpm e2e
pnpm e2e:relay
pnpm e2e:provider
```

To run the local development environment:

```bash
cp .env.example .env
pnpm dev:environment:up
```

The desktop app runs on an mdbn-daemon build:
`MDBN_DAEMON_BIN=<absolute path to mdbase> pnpm dev:desktop:fresh`.

See [Testing](docs/testing-environment.md),
[Maintainability](docs/maintainability.md), and [Releasing](docs/releasing.md)
for the complete workflows.

## License

[MIT](LICENSE)
