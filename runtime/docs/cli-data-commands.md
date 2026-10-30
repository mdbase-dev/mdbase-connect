# Data commands in the `mdbase` CLI

Status: implemented in `crates/daemon/src/data.rs` (phases 1 to 4).

The `mdbase` binary (`crates/daemon`, `src/cli.rs`) administers the daemon,
collections, sync, devices and app access. It cannot read or write records. The
retired connector CLI could (`mdbase --root PATH query …`, `mdbase --collection ID
read …`), and scripts and agents relied on that. This plan restores record access
for local collections. Thin-client access to hosted collections is out of scope.

## Commands

Data commands sit at the top level, beside the administrative ones. No names
collide.

| Command | Replica method | Phase |
|---|---|---|
| `read PATH` | `get` (with the document) | 1 |
| `query` (`--types`, `--where`, `--order-by`, `--limit`, `--offset`, `--include-body`, or `--request FILE\|-`) | `query` | 1 |
| `validate [PATH]` | `validate` | 1 |
| `types list`, `types show NAME` | `describe` | 1 |
| `create --path --type --fields JSON`, `update PATH --fields JSON`, `delete PATH`, `rename FROM TO` (`--body`/`--body-file`, `--if-revision`, `--dry-run`) | `submit` | 3 |
| `batch --request FILE\|-` | `submit` | 3 |
| `views`, `changes`/`watch`, type writes, packs | various | later, on request |

The connector CLI's `backfill`, `migrate`, `migrate-v02` and `cache` commands are
not carried over.

## One command layer, two transports

The daemon and the library host the same `Replica`, which implements `ClientApi`
(`crates/replica/src/api.rs`) and serves it as the replica client API
(`docs/contracts/replica-client-api.md`). Each data command is therefore built
once, as replica client requests, and sent over one of two transports:

- **Daemon.** When the daemon serves the folder, the CLI opens a host session on
  the profile's replica endpoint, authenticated with the keychain's host Noise key
  (`secrets::host_noise_secret`). `examples/lab_smoke.rs` already does this.
- **In process.** When no daemon serves the folder, the CLI opens it itself as a
  library host (folder host lock, `HostKind::Library`) and calls the same API in
  process.

Building on the client API rather than the `mdbase` facade's typed methods keeps
one implementation and exposes what the facade does not (`dry_run`, views, type
writes). It also respects the crate rules: `mdbn-daemon` may not depend on
`mdbase`. The facade's open sequence (descriptor check, folder lock, identity,
store, `LocalReplica`) moves into `mdbn-local-host`, which both crates already
use, and the facade calls it. That is a move, not a copy.

## Choosing the target and route

- The target is `-C/--root PATH`, defaulting to the current directory, or
  `-c/--collection ID|prefix|name`, resolved like the administrative commands.
- A folder registered with a running daemon goes through the daemon. Any other
  folder is opened in process.
- A folder registered with a daemon that is not running fails with
  `daemon_not_running`. It is not opened in process instead, because record IDs
  would then differ from the daemon's (below).

## Contracts

- **Paths first.** The library and the daemon each assign their own record IDs,
  so an ID is meaningful only on the route that produced it. Commands accept
  paths and print them first.
- **Output.** `read` prints the Markdown document and `query` one path per line.
  `--json` prints the replica result, or `{"error": {code, message, reason}}` with
  the 15 shared error codes.
- **Exit codes are unchanged** (0 success, 1 error, 2 usage, 3 daemon not
  running, 4 already running), because the desktop parses them. Data errors exit
  1 with the code in the output. `validate` exits 1 when any issue has error
  severity. The connector CLI's codes for validation, configuration and not-found
  are not carried over.
- **The daemon route admits only data methods.** A host session has owner power,
  so the transport takes a closed `Method` enum rather than a method name: device
  approval and the other host-only methods cannot be sent from a data command. A
  daemon-side list keyed on the client name would not help, because any holder of
  the host key can claim any name. `hello` carries the client name `mdbase-cli`.

## Writes

- The flags follow the retired connector CLI's, so its scripts keep working:
  `create --path P --type T --fields JSON`, `update PATH --fields JSON`,
  `delete PATH`, `rename FROM TO` (links are updated unless `--no-update-refs`).
  `--body TEXT` and `--body-file FILE|-` set the body. In `update`, a field set to
  `null` is removed.
- `batch --request FILE|-` takes `{"ops": [...], "dry_run"?}`, each op shaped like
  the commands (`{"op": "create", "path", "type", "fields", "body"}`, `update`
  with `path`, `fields`, `body`, `if_revision`, `delete`, `rename` with `from`,
  `to`, `update_refs`), and applies them as one mutation: all or nothing.
- Records are named by path. Each is resolved to its ID with `get` on the same
  session, because IDs are route-scoped.
- Every call submits a fresh mutation ID with `conflict_mode: reject` and
  `wait: published`. A command returns once the file is written, or is known not
  to be (then it says so and points to `mdbase holds`). A local-only write is
  confirmed on the replica's next tick; a synced one when the log appends, which
  the command does not wait for.
- `--dry-run` previews the records without writing.

## Phases

Each phase is one PR.

1. **Reads, in process.** Move the open sequence into `mdbn-local-host`. Add the
   command layer, the in-process transport, `read`, `query`, `validate` and
   `types`, with tests on a temporary folder.
2. **Daemon transport.** Host session client, routing, the method allowlist, and
   the sign-in question below. A parity test runs each command over both
   transports and compares the output, ignoring IDs. A test checks that the
   folder lock forces the daemon route.
3. **Writes.** `create`, `update`, `delete`, `rename` and `batch`, with
   `--if-revision`, `--dry-run` and a fresh mutation ID per call.
4. **Docs.** `docs/headless.md`, the README and the CLI help. The repository
   root's `docs/unified-cli.md` is marked as describing the connector CLI.

## Open questions

- **Sign-in (resolved).** Deliberate. Every registered collection, local-only
  included, is bound to the account and device that registered it
  (`owner_account`, `device`), and the daemon does not open one until that account
  is signed in: its state is `unavailable` with reason `account_identity_missing`
  (`collections.rs`). There is nothing to exempt. The daemon route reports the
  collection's state before opening a session and, for this reason, says to run
  `mdbase account sign-in`.
- **Open cost (measured).** The in-process route rescans the folder and keeps
  library state under `<root>/.mdbase/library/`. On a release build with
  half-kilobyte records, the first open takes 0.14 s for 1,000 records and 1.5 s
  for 10,000 (23 MB of state); later opens take 0.02 s and 0.17 s. That is cheap
  enough for scripts that loop, so the CLI keeps no cache of its own.
- **Whole-collection `validate` (resolved).** The replica's validation budget
  (4096 work units per request) refused `validate` with no paths past roughly
  600 linked records, and a `unique` rule made every record scan the whole
  collection. Uniqueness checks now use the store's unique index, which covers
  every record for every field a rule names, and `validate` takes a page
  (`validate-page-v1`, `docs/contracts/replica-client-api.md` §4). The CLI and the
  SDK page through every record: 10,000 records with a collection-scoped
  `unique` rule validate in 0.35 s on a release build.
