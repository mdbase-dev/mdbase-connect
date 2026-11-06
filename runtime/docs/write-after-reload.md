# Reloaded writes and permanent append refusal

## Evidence and reproduction

Investigation date: 2026-11-06. The supplied Reader round-6 evidence names Reader
`bc75b8a01` and `sdk-dev-eaa4e697-lab.tgz`. That SDK's provenance identifies runtime
`mdbase-dev/mdbase-next@725d72b2e43b2b744062e055e43feaeb41838399`.
This is not the runtime source currently at Connect main.

`reload_then_write_rebuilds_epoch_one_without_replaying_content` in the replica
`join_ahead` suite exercises the production KeyringSealer with signed control
items, a rekey, a device granted epoch 2 after that rekey, a confirmed fresh-session
write, and a new Replica/Sealer over the same persisted store. The store uses the
web runtime's RAM-only-keyring rebuild contract. The test inspects the actual
outgoing Item, validates its wire shape, checks the next sequence, and confirms
the reopened write through another replica. It also asserts that keys were never
persisted to the store.

Restoring the historical `accept_key_grant` behavior (install only the granted
epoch, not its authenticated history) made this test fail on the outgoing Entry
with `Item: header fields do not match the item kind`. Fresh replay encounters old
encrypted content, so join-ahead recovers old keys. A warm reopen already has the
confirmed content and rebuilds keys using only control items. The historical
grant handler recovers K2 but not K1 on this path. Entry sealing can use K2, but
idempotency-token derivation needs K1: it returns None, and the previous append
builder emits an Entry without required field 8. Explicit `idem: None` on control
items and Base items is correct and is not this defect.

The history recovery is already present on the branch's main baseline, imported
by `734539a2a` (#1080). This change keeps that canonical history recovery and adds
the missing reopen regression and a pre-append invariant: no Entry is emitted
without an idempotency token. A current-epoch-only keyring is additionally
injected in the regression to verify that this reachable partial-state failure
is reported without sending malformed bytes or deleting the original mutation.

The old HTTP log service source also used response ID 0 for service refusals.
The replica correctly requires the original request ID. A mismatched refusal
becomes NoResponse, whose existing retry policy sends the same bytes after one
second. Main already echoes the original ID, with an existing DO ingress
correlation regression in `tests/cors-cases.mjs`. This explains the historical
source's resend mechanism; the supplied decoded-item evidence does not establish
the exact running LAB log Worker revision. Do not weaken request correlation to
accept unrelated ID-0 errors.

### Sequence and field 9

The evidence compares `before_reload_status_write_ctx5` (212) with
`after_reload_add_ctx1` (190): different browser contexts/runs and different
operations, not a same-instance head trace. Field 9 is attachment refs; the status
write has none, whereas a file-add Entry does. Neither difference proves an
Item-kind change or a counter rollback. The builder derives sequence from that
replica's applied head plus the batch offset; retries of one refused batch keep
its original sequence. Thus a stuck context can keep sending 190 while a later
healthy context sends 212. The artifacts do not establish why those contexts had
different heads. The regression proves that reopening the same confirmed store
does not change its head and the next write uses head + 1; no sequence-reset fix
is justified by the supplied evidence.

### Stop is a separate defect

The `attachment_upload_scope_changed` refusal occurs in `client_upload_open_existing`,
before Entry construction: a different open conflicts with the still-live upload
lane. The SDK skipped abort cleanup once commit started. Cancellation during that
request could therefore leave the lane open, even though the UI moved on.

The SDK now releases the lane on terminal failure/cancellation even during commit;
transient reconnect/resume behavior is unchanged. Native abort closes the transfer
but does not delete a captured PendingRow. A native regression verifies this and
opens the next upload; public SDK wire-peer regressions exercise cancellation both
before capture and with a captured commit whose reply was lost. They fail before
the SDK fix and pass afterward. Stop cannot promise "nothing was added" when
commit may already have captured the write: the returned mutation identity and
receipt remain the outcome authority. This PR does not change Reader UI copy.

## Read-only production exposure assessment

No production/staging sign-in, mutation, release operation or deployment was used.
The public production health response identified the control-plane revision
`21d6dfa617aea55097713a5e4259ba78ba256175`. That source contains both the key-history
recovery and corrected HTTP refusal correlation. A control-plane health response
alone does not attest every serving log Worker or a browser's cached WASM.

Reader origin/main pins `sdk-4370800f-production-beta156.tgz`. Reading that Git
artifact and the public npm `@mdbase-dev/sdk@0.1.0-beta.156` package established
byte-identical archives (SHA256
`33ae4974f40606bfb0c75255a91669e81cd28adf972935e8a96ba2efac820115`).
Their embedded native provenance identifies runtime
`1e6b83c6b338b8ce708de7e2cbddb05992d8dc11`; the extracted WASM hash matches its
declared pin, `b4e5b26f101072655d8c880c2355a044cb7afb6e4ffbbdef403db2dda9358010`.
The npm latest tag at inspection was beta.157, embedding
`3e433313e0a234513478789686a4f4274e4dd76c`, with verified WASM SHA256
`d375ce16a48dec718801704f56ffb6a545247a2793912c2c8e68ceb171ff2537`.
Both source revisions contain the history recovery and corrected refusal ID.

Consequently the deterministic historical missing-history reload defect is not
present in those named production SDK artifacts. The unguarded optional-idem
append builder and non-durable/per-change-invisible refusal handling are present;
this PR hardens that residual path. Older pinned/cached SDKs or incomplete local
state can strand real acknowledged local intent behind an invalid append. This
investigation establishes no actual production customer loss, no census of old
browser installations, and no assertion that every production request executed
the inspected artifact. Rejected Entries were not accepted into the shared log;
clearing their device journal can lose the only captured record contents.

## Retention and recovery contract

No wire fields, public state enums, database columns or new queue are added.
The existing LocalReceipt and PendingRow deliberately coexist for an
`append_refused` rejection. This reason denotes an internal invariant/permanent
service refusal, not ordinary invalid user input. The original mutation, effects,
ownership and upload references remain in the ordered journal. Receipts, scoped
pending inventory and SDK ledger report Rejected/contact_support, naming the
mutation and its target records. Only committed rejection markers are published.

The append loop stops, including after reconnect/reopen, rather than silently
skipping dependent writes. Replanning cannot rewrite the parked original.
All stores retain local receipts while their pending row exists; the shared store
conformance test covers pruning and eventual pruning after row deletion.
Confirmed/lost-ACK receipts still follow their existing pending precedence.

Apps can show `client.ledger.getSnapshot().rejected`, inspect the Problem recovery
action, and retrieve the original operations via `client.pendingWrites()` before
offering support/export recovery. `ledger.acknowledge()` acknowledges a notification,
not native-journal deletion or retry authorization; retained refusals can be
rediscovered after reopen. No automatic retry/discard API or promise to reconstruct
remote attachment bytes is added. Do not clear device storage to clear the error.

## Permanent CI coverage

- `.github/workflows/runtime-ci.yml` runs for `runtime/**` pull-request changes and
  calls `runtime-native-tests.yml`. Its replica shard runs
  `cargo test --locked -p mdbn-replica`: the actual persisted-reopen/keyring/Entry
  test and durable-refusal/abort regressions run unconditionally there.
- Its workspace shard runs store conformance (including real native SQLite; the
  PostgreSQL lane supplies its disposable database) and its SDK job builds the
  integration WASM, then typechecks and runs `npm test`, including ledger reload
  and upload-cancellation tests.
- Root `pnpm test:runtime-sdk -- <test-name>` provides a finite rpnpm entrypoint
  for SDK typecheck and Vitest without converting its npm lockfile. The full
  selection requires `runtime/target/wasm/runtime.wasm`, as in Runtime CI.
- `pnpm ci:local` is Server CI's separate root-workspace gate, not a substitute
  for the shipped-runtime suites above. `pnpm e2e` is the local request-path suite.

## Validation record

- Before: the historical key-grant handler reproduced the malformed outgoing
  Entry; the permanent-refusal regression failed Pending versus Rejected; both
  SDK Stop/commit interleavings failed because abort was never called. The
  historical-handler experiment was reverted, not shipped.
- After: `rcargo test --locked -p mdbn-replica -p mdbn-store-file
  -p mdbn-platform-native` passed, including 1,144 replica tests and actual native
  SQLite conformance. Focused reopen, refusal and receipt tests passed again
  after the final receipt-view changes. Clippy with `-D warnings` passed for
  replica, store-file and store-pg; `rcargo xtask arch` passed all 27 crates.
- SDK typecheck and the seven focused cancellation/ledger tests passed through
  rpnpm. The broader SDK run passed 174 test files (2,347 tests, one skipped),
  but its WASM integration file could not start because the local build artifact
  `runtime/target/wasm/runtime.wasm` was absent. Full SDK integration is not
  claimed; Runtime CI builds that artifact first.
- `pnpm ci:local` and `pnpm e2e` passed. Finite JS build/test work used rpnpm;
  the isolated local-service E2E harness stayed local. Its initial invocation
  exceeded Unix socket path length; a shorter worktree-owned temporary directory
  fixed the environment without a source change.
- Changed Rust files pass rustfmt. Workspace-wide formatting still reports three
  untouched baseline files: replica's `replica/attachment_ingest.rs`,
  `tests/attachment_ingest.rs` and `tests/disk.rs`. No unrelated formatting fix
  is included. PostgreSQL compiled and its conformance assertions were updated,
  but no live PostgreSQL service or live LAB browser was exercised locally.
