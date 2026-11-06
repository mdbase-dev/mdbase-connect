# Reloaded writes and append retries

## Root cause and evidence

The 2026-11-06 Reader round-6 evidence names Reader `bc75b8a01` and
`sdk-dev-eaa4e697-lab.tgz`, embedding runtime `725d72b2e43b2b744062e055e43feaeb41838399`.
That historical key-grant handler installs K2 but not K1 from authenticated history.
Fresh replay encounters old encrypted content and join-ahead recovers K1; a warm
reopen has that content already and rebuilds its RAM-only keyring from control items.
Sealing can use K2, but idem derivation requires K1: the old builder emits a kind-1
Entry without required field 8. Control/Base `idem: None` is unrelated and correct.
Main already contains authenticated history recovery, imported by `734539a2a` (#1080).
The real-key replica reopen regression exercises this mechanism and its repair.

Historical HTTP refusals also used response ID 0. A mismatched response becomes
NoResponse and retries the same bytes after a second. Main already fixes correlation;
the supplied artifacts do not attest the historical LAB log Worker's exact revision.

Seq 212 (`before_reload_status_write_ctx5`) and 190 (`after_reload_add_ctx1`) compare
different contexts/runs and operations, not a same-instance head trace. Field 9 is
attachment refs. A retry retains its sequence; each new batch uses the applied head.
The artifacts do not establish why the contexts had different heads or prove rollback.
Stop is separate: SDK cancellation during commit skipped upload-lane cleanup, so the
next open conflicted before Entry construction. Cleanup now releases the lane without
deleting captured intent. Stop cannot promise nothing was added after a lost commit reply.

## Read-only production assessment

The inspected production health response names control-plane revision
`21d6dfa617aea55097713a5e4259ba78ba256175`. Reader's requested beta156 vendor archive
and public npm beta156 are byte-identical (SHA256 `33ae4974f40606bfb0c75255a91669e81cd28adf972935e8a96ba2efac820115`),
embedding runtime `1e6b83c6b338b8ce708de7e2cbddb05992d8dc11`. Npm beta157, latest at
inspection, embeds `3e433313e0a234513478789686a4f4274e4dd76c`. WASM hashes match their
declared pins. Those sources contain history recovery and corrected refusal IDs.
The deterministic historical key-gap reopen defect is absent from these named artifacts;
the unguarded optional-idem/refusal path remains. Older cached clients or partial keys
can strand captured data. No actual production customer loss or installation census is
established. Health does not attest every log Worker or cached browser WASM. Clearing a
device journal can lose its only captured contents. No production/staging sign-in,
mutation, deployment, or release operation was performed.

## Recovery contract and hosted boundary

Unclassified append refusals create no durable Rejected receipt. Original rows remain pending;
existing replanning handles peer conflicts normally. Missing K1 raises ephemeral
`key_inconsistent`, attempts `refresh_mode_history()`, and sends nothing malformed;
writing resumes and the incident clears when token derivation succeeds. Unclassified
refusals such as `invalid/cbor_alloc` raise ephemeral `integrity` with service code,
reason and retry delay. Content retries double from 1 s to a 60 s cap, honouring longer
`retry_after_ms`. Reconnect/control success cannot bypass the deadline. Reads and control
work continue; content is not dropped, skipped or reordered. Content success or an empty
queue clears this append-specific incident. Timers/incidents reset on reopen, not intent.
`describeError(incident)` gives plain delayed-sync copy. No new persisted fields or API.

Hosted pending lives in HostedCache RAM, unlike device/app-local persisted pending.
Hosted submit success still requires the log ACK. Live-instance retries use this loop;
timeouts/cancellation keep existing hosted semantics, and cold restart cannot recover
never-appended RAM intent from the log. Device `refresh_mode_history()` does not run for
hosted mode; its warm-wake reconstruction is separate. No hosted durability, hosted
key-gap repair, or live hosted/LAB qualification is claimed from device tests.

Runtime CI's replica shard covers reopen/repair, refusal/backoff, peer conflict, control
rekey and native abort. Its workspace shard runs the actual SQLite reopen-then-write
test in `platform-native/tests/native/tentative_discovery.rs`, using TentativeStore's
SqlStore composition (not browser OPFS). The SDK job builds WASM before testing incident
copy and Stop races. Root `pnpm ci:local` and local `pnpm e2e` are separate gates.
