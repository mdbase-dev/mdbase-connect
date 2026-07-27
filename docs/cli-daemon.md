# CLI and daemon architecture

## Decision

`mdbase-connect` is the user-facing command and the durable local Connect
runtime. The desktop application and command line are peers: both control one
per-user daemon over the versioned local control protocol.

The daemon, not Electron, owns local collection registration, cloud relay
connectivity, browser loopback access, hosted filesystem mirrors, credentials,
background work, and synchronization state. Closing the desktop must not stop
these services.

`mdbase` and `mdbase-connect` remain separate products:

- `mdbase` and `mdbase-rs` own collection format and behavior.
- `mdbase-connect` owns identity, authorization, routing, replication, and
  service lifecycle.
- The dependency points from Connect to published mdbase library APIs, never
  from mdbase to Connect.

During pre-release development the workspace intentionally uses the adjacent
`../mdbase-rs` checkout. Release builds must replace that path with an immutable
dependency.

## Process model

```text
┌─────────────────┐
│ mdbase-connect  │
│ CLI             │
└────────┬────────┘
         │ versioned per-user socket / named pipe
┌────────▼────────┐
│ Connect daemon  │◀──────────────┐
│                 │               │
│ local authority │       ┌───────┴────────┐
│ hosted mirrors  │       │ Desktop client │
│ relay + loopback│       └────────────────┘
│ credentials     │
└──────┬─────┬────┘
       │     │
       │     └──────── Connect control plane and hosted authorities
       └────────────── user-owned mdbase directories
```

Only the daemon opens the local registry, holds collection and mirror leases,
watches filesystem authorities, advances mirror journals, or maintains relay
connections. Commands are requests, not independent state owners.

## Command model

The public command groups are:

- `mdbase-connect status`
- `mdbase-connect login`, `logout`, and `whoami`
- `mdbase-connect daemon run|install|uninstall|start|stop|restart|status|logs`
- `mdbase-connect collection list|add|add-copy|create|remove|validate|transfer-authority`
- `mdbase-connect hosted list|create|rename|delete`
- `mdbase-connect mirror list|add|sync|resolve|promote|remove`
- `mdbase-connect access list|pause|resume|approve|deny|update|revoke`
- `mdbase-connect activity`
- `mdbase-connect doctor`

Commands print calm, human-readable output by default. `--json` emits a stable
machine contract containing the result rather than the local control envelope.
Diagnostics go to stderr. Stable error codes determine non-zero exit status.
Commands that identify an existing collection, mirror, request, or grant use
its stable ID.

`daemon run` is the foreground primitive used by service managers, containers,
tests, and debugging. `daemon install` registers a per-user launch agent,
systemd user unit, or Windows per-user background task. It must not require an
administrator or run as a different operating-system user.

## State and secrets

The daemon state directory contains:

- the local collection registry;
- the hosted mirror registry and durable mirror journals;
- the relay identity;
- versioned configuration containing non-secret server origins;
- logs and diagnostic metadata.

The directory and local control endpoint are owner-only. Relative overrides
are resolved before a daemon or service manager receives them.

Connector credentials and mirror renewal credentials live behind a
`SecretStore` interface. Production uses the operating-system credential store.
Tests use an isolated implementation. Cross-process integration tests may
explicitly select an owner-only file backend with both
`MDBASE_CONNECT_ENV=test` and
`MDBASE_CONNECT_SECRET_BACKEND=insecure-test-file`; production never falls back
to plaintext silently.

Credentials are not accepted through ordinary command arguments and never
appear in status output, process arguments, logs, control errors, or support
bundles.

Account changes use a recoverable two-phase local commit: the new credential is
staged in the operating-system store, a non-secret digest binds it to the
staged server origin, and daemon startup completes any interrupted commit. A
torn or mismatched stage fails closed rather than pairing a credential with the
wrong server.

## Hosted mirror invariants

- One canonical filesystem directory has exactly one mirror owner.
- A directory cannot overlap another mirror or a registered local authority.
- The non-secret `.mdbase/connect-role.json` marker binds the directory to its
  collection before any content is written.
- Mirror state and credentials remain outside the mirrored collection.
- Writes are atomic where the platform permits.
- A local mutation is journaled durably before upload.
- Idempotency keys survive process termination and ambiguous network failures.
- The daemon never silently chooses between local and hosted content.
- A receive-only mirror stops at local divergence.
- A writable conflict isolates one record while unrelated records continue.
- Configuration and type resources remain authority-owned.
- Revocation stops synchronization without deleting local files.
- Revocation intent is durable before the remote call; ambiguous responses and
  interrupted local cleanup resume idempotently with bounded backoff.

The Rust mirror engine uses the Connect replication protocol and public
`mdbase-rs` document APIs. It does not duplicate validation, query, type, view,
or mutation semantics.

## Desktop boundary

Electron is responsible for windows, native folder selection, opening browser
approval pages, notifications, and presenting state. It does not own a second
mirror registry, cloud credential, retry loop, or agent child process.

At startup the desktop:

1. connects to the standard daemon endpoint;
2. asks the installed per-user service to start if the endpoint is absent;
3. presents a repair action if the service cannot start;
4. subscribes or polls for versioned status.

Desktop exit closes only its control connection.

## Failure model

The daemon must recover safely from:

- duplicate startup;
- power loss during state or file replacement;
- malformed state and configuration;
- a moved, deleted, replaced, or symlinked mirror directory;
- local edits during an outstanding upload;
- expired or revoked credentials;
- snapshot cursor expiry;
- HTTP success with a lost response;
- partial initialization;
- database busy and disk-full errors;
- clock changes;
- relay and hosted-authority outages;
- daemon upgrade and restart.

Failures are visible as stable codes with a next action. Repeated background
failure uses bounded exponential backoff with jitter and does not erase the
last successful state.

## Testing contract

Every control command has serialization and authorization tests. CLI rendering
has golden human and JSON output tests. The mirror engine shares protocol and
Markdown fixtures with the TypeScript reference implementation until the Rust
engine becomes canonical.

Required suites include:

- deterministic mirror state-machine tests;
- injected filesystem and persistence failures;
- concurrent owner and overlapping-path tests;
- malicious path and symlink tests;
- cursor reset and snapshot-boundary corruption;
- mutation replay and lost-response tests;
- conflict and rejection resolution;
- daemon crash/restart and service-manager fixtures;
- account and credential redaction;
- desktop/CLI convergence against one daemon;
- production-style end-to-end hosted mirror tests.

Release qualification builds from a clean checkout, runs both language suites,
exercises signed packaged artifacts, and proves that the desktop can remain
closed while a mirror continues synchronizing.
