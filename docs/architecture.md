# Architecture

This document describes the current `mdbase-next` / Connect architecture: one
deterministic Rust core (`runtime/`), a blind signed log service, a portable
hosted replica running in Cloudflare Workers, the native desktop daemon
(`mdbn-daemon`), the Connect control plane and transient relay
(`services/server`), and the native TypeScript SDK (`@mdbase-dev/sdk`).

For detailed wire formats, policy verification, and crate boundaries, see
[`runtime/README.md`](../runtime/README.md) and
[`runtime/docs/README.md`](../runtime/docs/README.md).

## Platform boundary

mdbase defines the portable Markdown collection format and record semantics.
All collection semantics—parsing, format-preserving YAML patching, types, CEL
evaluation, links, three-way merge, query planning, and holds—live in
`runtime/crates/core` (`mdbn-core`) and `runtime/crates/replica`
(`mdbn-replica`). Applications, servers, and gateways ask the runtime rather
than duplicating collection semantics.

Five trust zones make up the system:

1. **Applications** (`@mdbase-dev/sdk`, e.g., `apps/editor` and third-party
   web/native apps), authenticating via OAuth/PKCE or installation pairing and
   opening Noise IK sessions directly to replicas.
2. **Control plane & transient relay** (`services/server`), owning accounts,
   device/connector pairing, application identity, grant policy issuance,
   signed policy updates, and transient WebSocket relay routing. It never
   persists record payloads or receives local filesystem paths.
3. **Blind shared log** (`mdbn-log-service`, hosted in Cloudflare Durable
   Objects / `mdbn-log-server`), storing signed, encrypted log items,
   snapshots, and binary blobs without interpreting collection content.
4. **Replicas**:
   - **Desktop daemon (`mdbn-daemon`)**: runs on the user's computer, hosts
     local, Private (E2E), and Cloud copy replicas over `mdbn-store-file` and
     `mdbn-platform-native`, enforces local access grants, and holds the OS
     keychain device identity.
   - **Hosted replica (`mdbn-hosted-worker`)**: runs `mdbn-core` + `mdbn-replica`
     compiled to WebAssembly inside a per-collection Cloudflare Durable Object
     with AWS KMS custody wrapping for Cloud copy collections.
5. **Application gateways** (`services/mcp`), acting as authorized applications
   that translate external protocols (MCP) without weakening collection grants.

## Collection modes and authority

Every collection has a stable UUID and runs in one of three modes:

- **Local only (`local`)**: hosted solely by `mdbn-daemon` on one computer with
  no cloud log. Remote web apps reach it through the daemon over a
  Noise-encrypted relay pipe when the computer is online.
- **Private (`synced_e2e`)**: end-to-end encrypted through the blind shared log.
  Only the user's approved devices hold collection epoch keys (wrapped via the
  account key or verified device-to-device SAS approval). mdbase servers never
  decrypt record content.
- **Cloud copy (`synced`)**: uses the same blind log with the hosted Worker
  replica (`mdbn-hosted-worker`) enrolled as a service device, so web and
  mobile applications can connect directly to the hosted replica even when no
  user computer is online.

Switching between Private and Cloud copy is an explicit owner-approved
collection-mode transition documented in
[collection-mode-api.md](collection-mode-api.md),
[collection-mode-execution.md](collection-mode-execution.md), and
[private-cloud-handover.md](private-cloud-handover.md).

## Components

- **`runtime/` (`mdbase-next` Rust & WASM workspace)**:
  - `mdbn-core`, `mdbn-wire`, `mdbn-replica`, `mdbn-store-file`, `mdbn-noise`:
    deterministic, portable core and replica engine.
  - `mdbn-daemon`: per-user native daemon and `mdbase` CLI; hosts local and
    synced folder replicas, local IPC, localhost link, and the Noise relay
    session.
  - `mdbn-hosted-worker` + `runtime/deploy/hosted-worker`: Cloudflare Worker +
    Durable Object hosting Cloud copy replicas over WASM with AWS KMS key
    custody.
  - `mdbn-log-service` / `mdbn-log-server` / `runtime/deploy/log-service`:
    blind shared log service (WASM Durable Object and native server).
  - `mdbn-wasm`, `mdbase`, `mdbase-node`, `mdbase-wasm`: embeddable Rust,
    Node.js, and WASM libraries.
  - `@mdbase-dev/sdk` (`runtime/packages/sdk`): primary TypeScript SDK for web
    and native applications.
  - `@mdbase-dev/obsidian-runtime` (`runtime/packages/obsidian-runtime`):
    Obsidian vault runtime host.
- **`services/server` (`@mdbase/connect-server`)**: Fastify/PostgreSQL control
  plane and NATS-backed transient relay. Schema changes follow
  [control-plane-migrations.md](control-plane-migrations.md).
- **`apps/portal`**: Account, collection, computer, permission, and recovery
  web UI (separate HttpOnly account session; never shares credentials with
  collection apps).
- **`apps/desktop`**: Electron desktop shell and tray UI controlling
  `mdbn-daemon` over the local owner-only control socket/pipe.
- **`apps/editor`**: First-party Markdown collection editor built directly on
  `@mdbase-dev/sdk` (see [apps/editor/NEW_SDK.md](../apps/editor/NEW_SDK.md)).
- **`services/mcp`**: Hosted OAuth MCP gateway (`https://mcp.mdbase.dev/mcp`).
- **`packages/protocol`**: Shared protocol schemas, problem codes, and
  generated TypeScript inventories.

## Application identity, authorization, and sessions

Account sign-in is separate from collection authorization:

- Accounts support email/password, Google Identity Services, and GitHub OAuth
  (see [account-authentication.md](account-authentication.md)).
- Applications bundle a manifest identified by SHA-256 digest and request
  collection-scoped capabilities and optional declared contracts/type packs.
- Users approve grants in the Connect portal (or on-device when local approval
  is enabled). Changing a manifest requires a new explicit approval.
- Grants are delivered to `mdbn-daemon` via signed, sequence-ordered,
  lease-bounded `policy_snapshot` updates over `/v1/relay` and enforced locally
  at the daemon before opening or serving any session.
- Application sessions use Noise IK handshakes directly with the serving
  replica (either `mdbn-daemon` via local/relay pipe or `mdbn-hosted-worker`
  for Cloud copy collections). The relay forwards opaque ciphertext frames.

For detailed grant policy, joint consent, and encryption boundaries, see:

- [encryption.md](encryption.md)
- [next-grant-policy.md](next-grant-policy.md)
- [next-joint-consent.md](next-joint-consent.md)
- [collection-sharing-policy.md](collection-sharing-policy.md)
- [files.md](files.md)
- [notifications.md](notifications.md)
- [threat-model.md](threat-model.md)

## Versioning and internal quality gates

The mdbase spec version, runtime wire contracts, Connect protocol version, and
app manifest versions evolve independently. Internal module ownership,
dependency direction, and quality gates are enforced by
`pnpm check:architecture` (TypeScript/server boundaries) and
`cargo xtask arch` (Rust crate boundaries and WASM portability). See
[code-quality.md](code-quality.md) and [maintainability.md](maintainability.md).
