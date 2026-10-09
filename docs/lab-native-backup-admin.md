# LAB native backup admin (draft source)

This is a **native-log-only capture adapter**, not a complete hosted backup or an
operational restore runner. No deployment, credentials, fixture/target creation,
production operation or Gate 4 qualification is implied.

Considered: existing service-local `auth-admin request`, Next config/key loader,
policy signer, CP denial helpers, nonce/role-1 transport, native export/import/aux
primitives and native offline verifier. Reused those mechanisms; the only new
modules own fixed command admission/private publication and observed cut closure.

## Fixed authenticated execution

Use the existing authenticated server-local administrator execution. No HTTP
route, generic RPC command, raw signing command or credential export is added.
The existing request envelope contains only this closed argv shape:

```text
next lab-backup capture
  --collection <original canonical non-nil UUID>
  --operation-id <new canonical non-nil UUID>
  --expected-revision <qualified runtime SHA40>
  --expected-source-origin <configured canonical HTTPS log origin>
  --actor <operator attribution>
  --reason <bounded attribution>
```

The environment must be exactly `lab`, `PUBLIC_URL` must be exactly
`https://connect-lab.mdbase.dev`, the runtime revision must match and the source
must match the trusted existing Next log configuration. All extra/duplicate flags,
caller signing bytes/digests, target selection, restore, resume and arbitrary
method selection refuse. Keys remain inside the admin process. Loading signer
and transport keys follows the first fresh CP denial read.

## Observed capture and completion

Fresh collection-locked CP transactions refuse permanent deletion, missing/current
cloud-copy service records and queued device revocation. The original CP genesis
must be one appended bounded batch, certificate/root/item-signature verified with
configured independent root pins. Repeat current denial before each remote phase,
every object range and signing; genesis/device substitution refuses.

Capture the actual authenticated native BEGIN header, all six explicit page-section
terminals and original page bytes. Compute item, address-sorted committed-object
and descending snapshot/expanded-ref inventory roots from the observed rows. Copy
and hash-check **every object before the FIRST FINISH**: FINISH releases ordinary
GC/retention fencing; repeating FINISH does not retain that fence. Its successful
observation must match the captured collection/session/head/chain/revision/page
count/final hash. No UNKNOWN result is retried or automatically aborted.

The command constructs canonical completion fields0..11 from those observations
and signs only `H("mdbase/v1/native-backup-completion", unsigned canonical map)`.
Policy/item/certificate/token domains remain distinct even with the same key.
The certified policy key is not, by its certificate alone, backup-purpose trust:
consumers must independently authenticate and pin backup-purpose signer, root,
environment, original collection/genesis and capture-context expectations before
using the existing offline verifier. The command does not fabricate `trust.cbor`.

The native-only capture context fields0..8 are tag
`mdbase-lab-native-log-capture/1`, `lab`, fixed CP origin, configured source origin,
original UUID, operation UUID, runtime SHA, original genesis SHA and header SHA.
Its SHA256 is completion10. It authenticates **no hosted durable-state manifest**.
A future complete-state adapter must observe authenticated encrypted hosted
artifacts/closure itself and version the context to bind their hashes; it must not
accept caller-provided signing hashes.

## Private artifact publication

Fixed stage, relative to the server's working directory:
`scratch/lab-native-backup/<operation UUID>`. Each directory is owner-only0700,
non-symlink and owned by the process; each file is exclusive0600 and synced.
Existing operations, including partial/uncertain stages, are never overwritten.

```text
operation.json
capture-context.cbor
completion.cbor                  # published LAST after fresh denial
cut/header.cbor
cut/finish.cbor
cut/pages/0000000001.cbor ...
cut/objects/<64 lowercase hex>.cbor ...
```

`cut/` uses the exact existing offline-verifier layout. Independent `trust.cbor`
and completion are distinct siblings outside the cut. Stdout contains bounded
metadata/counts and completion SHA only, never raw cut/auxiliary token/object/key
bytes. Completion is linked exclusively from a synced private temporary file only
after data/directory sync and fresh denial; its temporary link is removed before
success. Publication/durability failure remains CLOSED even if a closure file
exists: bytes alone cannot override an UNKNOWN operator outcome. Operator/audit
attribution is not a resumable effect permit or target receipt.

Fixed smaller LAB admission caps:1024 pages,16384 total rows,4096 objects,1024
snapshot pointers,64MiB retained page+object bytes,9MiB/object,1MiB/object range.
Existing native request/response limits and canonical CBOR checking are retained.
These are test-run admission bounds, not performance or whole-hosted guarantees.

## Still closed

- No qualified private-server→local-verifier transfer or operation/status readback.
- No authenticated complete hosted SQL/KV/alarm manifest or frozen same-cut join.
- No independently bound fresh target origin/namespace/server configuration.
- No guarded restore command; typed strict import/object/snapshot/aux methods alone
  do not validate an archive, prove EMPTY, activate serving or authorize effects.
- No interrupted capture/restore qualification. Native BEGIN has no qualified
  named-operation/status reconciliation. UNKNOWN requires explicit owner readback;
  a new invocation must not replay it blindly.

The full drill remains closed until these existing-owner seams are bound and the
composed source, independent trust, restore ordering and four checks qualify.
