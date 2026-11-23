# mdbase connect

[![What mdbase does, in two minutes](https://mdbase.dev/videos/mdbase-in-two-minutes.jpg)](https://mdbase.dev/videos/mdbase-in-two-minutes.mp4)

> [!IMPORTANT]
> **Beta:** The managed mdbase connect cloud service is transitioning from
> invite-only access to public signup. Existing invitation links remain valid.

mdbase connect lets you use the applications you choose with the Markdown data
you control. An application gets access to one collection only after you
approve the exact actions it can perform, and you can pause or revoke that
access at any time.

Your collection can stay in a folder on your computer, sync end-to-end encrypted
between your own devices (**Private**), or include a hosted replica (**Cloud
copy**) so web and mobile apps can reach it when your computer is offline.
Either way, it remains a standard [mdbase](https://mdbase.dev) collection
rather than being locked into an application-specific database.

## What you can do

- Connect web and native applications to local, Private (E2E), or Cloud copy
  collections using one authorization model.
- Review concrete permissions such as reading, querying, creating, or updating
  records before granting access.
- Keep local collection folders private and serve remote requests over
  Noise-encrypted pipes without opening an inbound port on your computer.
- Sync collections across devices through a blind, signed shared log with
  deterministic three-way merge and local conflict/hold preservation.
- Use your collections from MCP clients such as Claude and ChatGPT.
- Read, query, validate, and write collections from the `mdbase` command line.

## How it works

### Runtime and replicas (`runtime/`)

All mdbase collection semantics live in one deterministic Rust runtime
(`runtime/`, see [runtime/README.md](runtime/README.md)):

- **Desktop daemon & CLI (`mdbn-daemon`)**: runs on your computer, hosts one
  replica per registered folder over the native filesystem and SQLite index,
  serves local apps over IPC, and holds the Noise relay connection for remote
  clients. Your local folder paths never leave your computer.
- **Blind shared log (`mdbn-log-service`)**: stores encrypted, signed log items
  and blobs without interpreting Markdown records.
- **Hosted replica (`mdbn-hosted-worker`)**: runs the same portable Rust engine
  compiled to WebAssembly inside a Cloudflare Durable Object for Cloud copy
  collections, serving web apps directly over Noise pipes.
- **Control plane & relay (`services/server`)**: handles accounts, pairing,
  application identity, grant policy, log/route discovery, and transient relay
  transport without persisting collection payloads.

### Collection modes

- **Local only**: lives in a folder on your computer with no cloud log.
- **Private (end-to-end encrypted)**: syncs across your approved devices
  through the blind log. Collection keys stay on your devices and off mdbase
  servers; web apps reach it through an online device over a Noise pipe.
- **Cloud copy**: syncs through the same log with the hosted Worker replica
  enrolled so web and mobile apps can read and write even when your desktop is
  offline.

## Getting started during the beta

1. Create or sign in to your mdbase connect account.
2. Install the desktop app (or standalone `mdbase` CLI) for your platform.
3. Open the desktop app and sign in to pair your computer.
4. Add an existing Markdown folder (`mdbase collection add`) or create a Cloud
   copy collection.
5. In a compatible application, choose **Connect collection** and review the
   requested permissions before approving.

The Connect portal manages sign-in, pairing, collections, permissions,
computers, and account recovery. The desktop app owns local folders, sync
controls, device approval, and local app-access notices.

## Connect an MCP client

The managed MCP endpoint is:

```text
https://mcp.mdbase.dev/mcp
```

Add it as a remote or custom MCP connector in an OAuth-capable client. Each
collection receives an independent grant. See the
[MCP gateway guide](docs/mcp-gateway.md) for supported tools and trust
boundaries, and [ChatGPT and Codex plugin](docs/chatgpt-plugin.md) or
[Claude plugin](docs/claude-plugin.md) for plugin packages.

## Build an application

New web and TypeScript applications should use **`@mdbase-dev/sdk`**
(`runtime/packages/sdk`), the native SDK for the `mdbase-next` runtime:

```bash
pnpm add @mdbase-dev/sdk
```

`@mdbase-dev/sdk` handles collection sign-in and selection, Noise-encrypted
sessions to desktop and hosted replicas, typed record CRUD, CEL queries, live
subscriptions, file uploads, type and contract setup, and local-first work
before connecting. See [apps/editor/NEW_SDK.md](apps/editor/NEW_SDK.md) for an
end-to-end first-party consumer reference.

## Security and privacy

- Each grant binds one application, one collection, and an explicit set of
  operations and file scopes.
- The local daemon enforces grants on the computer that owns a local
  collection; local paths never leave the device.
- Application sessions to desktop and hosted replicas are Noise IK encrypted
  end-to-end; the relay sees routing metadata and ciphertext sizes, not record
  contents.
- Private collections keep decryption keys on your devices only; Cloud copy
  collections wrap hosted custody keys with AWS KMS.

See [Architecture](docs/architecture.md), [Encryption](docs/encryption.md),
[Threat model](docs/threat-model.md), and the unaudited
[Security audit preparation package](docs/security-audit-package.md). Report
suspected vulnerabilities privately via [SECURITY.md](SECURITY.md).

## Command line

The desktop app includes the `mdbase` CLI and background daemon (`mdbn-daemon`),
also published as a standalone headless archive for Linux, macOS, and Windows:

```bash
mdbase status
mdbase collection add /path/to/notes
mdbase sync enable notes
mdbase query --types task --where 'status == "open"'
mdbase read tasks/review.md
mdbase update tasks/review.md --fields '{"status": "done"}'
mdbase validate -c notes
```

See the [headless installation guide](docs/headless.md) and
[CLI and daemon guide](docs/cli-daemon.md) for service management and command
details.

## Release notes

See [CHANGELOG.md](CHANGELOG.md) for release history. Contributors add change
fragments under `changelog.d/` rather than editing `CHANGELOG.md` directly.

## Contributing

This repository contains the `mdbase-next` Rust/WASM runtime and `@mdbase-dev/sdk`
(`runtime/`), the control plane and relay (`services/server`), the Connect
portal (`apps/portal`), the desktop app (`apps/desktop`), the Markdown editor
(`apps/editor`), the hosted MCP gateway (`services/mcp`), and shared protocols
(`packages/protocol`).

Development requires Rust (`runtime/rust-toolchain.toml`), Node.js 24 LTS, and
pnpm 11.15.1:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm ci:local
```

Inside `runtime/`:

```bash
cd runtime
cargo xtask arch
cargo test --workspace
```

End-to-end suites:

```bash
pnpm e2e
pnpm e2e:relay
```

See [Contributing](CONTRIBUTING.md), [Documentation map](docs/README.md),
[Testing](docs/testing-environment.md), [Maintainability](docs/maintainability.md),
and [Releasing](docs/releasing.md).

## License

[MIT](LICENSE)
