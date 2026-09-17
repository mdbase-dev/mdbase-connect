# Recovering retained local writes

`runtime_capacity_exhausted` means the engine's bounded transaction journal is
full. It is not hosted storage quota exhaustion. A successful write can remain
in that journal until both its result and its change events are acknowledged.
Restarting the daemon does not acknowledge historical transactions.

New local daemon mutations retain a durable local owner before preparation. The
connector acknowledges terminal outcomes without waiting for a CLI response to
be delivered. Interrupted local claims are reconciled under the collection's
mutation gate before the next mutation: uncommitted preparations are cancelled,
committed outcomes are acknowledged, and committing/manual-recovery states are
preserved. Application and relay claims retain their existing durable response
ledger boundary. This does not add response replay to the local CLI: after a lost
response, read back the record and use revision preconditions rather than blindly
retrying a write.

## Preview (no changes)

Use the same state directory and collection ID as the failing command:

```sh
mdbase --state-dir <state-directory> connect collection recover-writes <collection-id>
```

The preview does not acknowledge claims. Opening a collection still performs
normal engine crash recovery, just as an ordinary read does. The preview lists
commit IDs, relative record paths, phase and recovery eligibility. `--json` also exposes acknowledgement flags, current-revision
verification, and the local recovery audit. No record bodies or host claim
capabilities are printed. The command is only available through local daemon
administration, not to applications or the control plane.

**Eligibility is not proof of local ownership.** Historical journals do not say
whether a local CLI or another host owned their response-recovery obligation.
Identify the exact transactions using independently retained operation results,
revisions and repair records. Leave unrelated or ambiguous transactions alone.
Never select a transaction merely because it is committed.

## Acknowledge selected, verified local writes

```sh
mdbase --state-dir <state-directory> connect collection recover-writes <collection-id> \
  --commit <verified-commit-id> --commit <another-verified-commit-id> --confirm-local
```

`--confirm-local` attests that the selected transactions were independently
verified local CLI writes with no outstanding response-replay owner. There is
no `--all` or force option. The command:

- validates the whole selection before acknowledging anything;
- refuses claims referenced by any retained application mutation ledger entry;
- refuses uncommitted transactions, pending events and records whose current
  revisions no longer match their committed after-images;
- rechecks transaction state and revisions under the engine's write lock;
- durably records each explicit selection before acknowledgement and its
  completion afterwards;
- acknowledges through the engine, never edits/deletes journal directories or
  changes record contents.

A later legitimate edit can make an old transaction ineligible. That is a reason
for separate investigation, not permission to restore old bytes or force recovery.

Recovery is per transaction, not atomic across the selection. If interrupted,
preview again: completed acknowledgements remain effective, and the audit shows
selected and completed timestamps. A selection without a completion timestamp
may have been acknowledged immediately before interruption; compare it with the
currently retained transactions. Retry only those still retained and eligible.

After recovery, read back the affected records before resuming a repair. Do not
raise the transaction cap, delete journals, or clear unknown claims to get past
an error.

## Compatibility

This adds the versioned local command `collections.recover-writes-v1` without
changing existing local protocol v5 request/response envelopes. An older daemon
rejects the unknown command; upgrade it rather than falling back to filesystem
editing. No remote Rust/TypeScript application protocol changes are required.
The local authority database advances to schema 5; older binaries must not be
used against an upgraded state directory. Engine inspection and guarded
acknowledgement live in `mdbase-rs`, including support for its readable legacy
journal versions.
