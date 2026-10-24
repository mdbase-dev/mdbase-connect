# Native backup archive and scratch restore (held)

No live deployment or drill is qualified by this code. Native Worker ownership is
`runtime/deploy/cloudflare-do`, not the older standalone log-server checkout.
The existing `backup_begin/page/finish`, strict `import`, object/snapshot imports
and `restore_aux` protocols are unchanged.

## Authenticated LAB command path

1. Run existing `next lab-backup capture` with its six exact flags, through the
   authenticated server-local admin request mechanism described in
   [LAB native backup admin](lab-native-backup-admin.md). It captures all six
   sections, every committed object (including snapshots, ref indices and
   attachment chunks), original timestamps and auxiliary state, and FINISH.
2. Independently authenticate/freeze backup-purpose signer, environment,
   collection, original policy roots/genesis and capture-context expectation.
   Install the resulting owner-only `trust.cbor` as a sibling of the stage's
   `completion.cbor`. Never construct trust from archive-provided keys/digests.
   Context includes the authenticated BEGIN header hash, hence this is an
   explicit post-capture step, not a fabricated pre-capture trust file.
3. The deployment owner must install a qualified native `mdbn-backup-verify` at
   fixed `<server working directory>/bin/mdbn-backup-verify`. There is no executable
   override or fallback. Its absence blocks verification, not capture.
4. Run `next lab-backup verify` with **the same six flags**, naming the same
   collection, operation UUID, source origin and runtime revision. It validates
   exact private stage layout, original operation identity, capture context bound
   to the current CP genesis, every persisted byte and the existing independent
   native verifier. Fresh CP deletion/revocation denial checks precede work and
   coverage publication. No remote log RPC or signing key is used by verify.
5. Only verified success publishes create-only, synced `coverage.json` LAST in
   `scratch/lab-native-backup/<operation UUID>/`. Missing trust/helper, malformed
   inventory, verifier refusal and UNKNOWN all fail closed. Repeated capture or
   publication never overwrites an operation. A publication/readback/audit failure
   is UNKNOWN even if files exist; reconcile rather than blindly retrying.

Capture returns `verified:false` and
`coverage:"requires-independent-trust-and-verify"`. Verify returns `verified:true`,
`current_authority_verified:false`, coverage SHA256 and `S_final`. No command
claims hosted-state reconstruction, current authority or production readiness.

Ops owns independent R2 upload/download. Upload exact manifest entries with
create-only writes, full byte readback and coverage LAST. Do not upload trust,
operation metadata or transient verifier files. Independent backup bucket
identity, retention, credential custody and scheduled operation remain ops-owned;
never use the live object bucket as an independent backup.

## Coverage v1

Canonical compact JSON, in this field order:

```json
{"schema":"mdbase-native-backup-coverage/1","scope":"native-log-only","current_authority_verified":false,"S_final":{"collection":"original UUID","head":4,"chain":"hex64","revision":12,"retained_from":1,"used_bytes":2147,"item_root":"hex64","object_root":"hex64","snapshot_root":"hex64","page_count":12,"final_hash":"hex64","object_count":4,"object_bytes":595,"header_sha256":"hex64","finish_sha256":"hex64","completion_sha256":"hex64","capture_context_sha256":"hex64"},"entries":[{"name":"capture-context.cbor","bytes":123,"sha256":"hex64"}]}
```

The example entries array is abbreviated. Actual entries contain exactly
`capture-context.cbor`, `completion.cbor`, `cut/header.cbor`, `cut/finish.cbor`,
all `cut/pages/0000000001.cbor` onward, and every
`cut/objects/<64 lowercase hex address>.cbor`, sorted by name. Coverage is not its
own entry. `S_final` is recomputed from the authenticated cut/completion. The
manifest is a coverage index, **not independently signed authority**: a future
gate must call `verifyNativeBackup` with independent trust, not accept hashes or
`verified` JSON alone. It rejects changed/extra/reordered manifest claims.

## Callable Node composition

Internal modules under `services/server/src/features/next/`:

- `filesystemBackupStore(absolutePrivateDirectory)`: bounded no-follow private
  file reads, exclusive0600 writes and directory sync. Caller creates the0700
  root. `readNativeBackupStage(root)` admits exact captured layout, excluding
  trust/operation metadata from archive files.
- `exportNativeBackup({capture,sink,verifier})`: existing LAB capture then
  create-only archive, persisted readback, offline authentication and publication.
- `publishNativeBackupCoverage(files,sink,verifier,beforePublish)`: close an
  existing capture. Admin `verify` uses this with current CP denial.
- `verifyNativeBackup(source,verifier)`: read all entries with bounded paths,
  counts, bytes and SHA256; invoke native verification; recompute coverage. This
  must run even after a transport-only R2 download.
- `restoreNativeBackup({source,verifier,target,admit})`: authenticates before
  admission or target effects. `target` is the existing typed `LogServiceClient`
  restore subset, **already bound to a separate scratch namespace/origin**.
  Original collection UUID is retained; it is never remapped to another UUID.

Store interface: `putIfAbsent(name,bytes)` and `read(name,maxBytes)`; immutable
per-operation namespace, atomic create-only writes and bounded reads are required.
Verifier config: `{executable:absolutePath,stageRoot:privateDirectory,trust:bytes}`.
The existing native CLI runs against a private transient copy, rejects abnormal
output/nonzero/stderr and removes that copy. No private keys enter its process.

`admit(phase,coverage)` is a mandatory target-bound owner callback. `empty` must
prove an independent fresh EMPTY target before the first write. `write` and
`activate` must freshly enforce isolation, current deletion/revocation floors and
effect authority. An archive cannot supply these facts. Do not use a no-op
callback outside isolated unit tests. The library itself does not authorize or
provision a scratch target.

Restore seeds original genesis with strict settings/plan, binds auxiliary
completion, copies all committed objects, imports retained items in16-item
requests, imports descending snapshots with complete expanded refs, replays every
original auxiliary page with exact ACK cursor/hash, then performs strict final
activation and head/chain readback. A bad ACK/refusal/UNKNOWN stops immediately;
there are no automatic retries, aborts, target clears or ordinary appends.
Objects, original times, tokens and nonces are not reconstructed from current
application state. Source URL-secret rotation and fresh target admission remain
external prerequisites before exposing restored traffic.

Capture retains #686's bounded64MiB,1024-page,4096-object/16384-row admission.
Restore additionally refuses snapshots with more than1024 expanded refs before
any target effect (native request decoder budget); native verifier bounds can be
stricter. These are small-collection adapters, not a bulk streaming framework.

## Evidence and remaining drill blockers

Tests cover independent native ordinary/compacted/indexed golden vector capture,
signed context, manifest readback/publication, strict restore/aux ordering,
corruption/current denial/UNKNOWN refusal, private filesystem layout and verifier
process handling. Composition tests mock the existing offline verifier boundary;
process tests use a synthetic executable. They do not qualify a real Worker,
trust file, source cut, target, R2 bucket or hosted rebuild.

Live drill is BLOCKED pending qualified source/admin deployment and fixed native
verifier binary, independent backup-purpose trust and transfer, bound fresh
scratch namespace + nonce/URL-secret rotation + current-denial admission, registry
recovery, hosted cache rebuild and end-to-end data/attachment checks. No deployment
or live writes are authorized by this document. Full CI/e2e and live drill remain
held during production bulk migration.
