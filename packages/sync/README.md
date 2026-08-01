# @mdbase-dev/connect-sync

Provider-neutral replication protocol and executable reference state machine for
mdbase authorities. It models stable record identity, pinned snapshots,
scoped ordered changes, conditional idempotent mutations, conflicts, cursor
reset, revocation, offline queues, and receive-only or writable Markdown
mirrors.

Markdown without a leading, complete YAML frontmatter block is a normal
record with `{}` persisted fields. Empty files and files beginning with an
unclosed `---` fence are preserved byte-for-byte as body content. An explicitly
empty frontmatter block is also accepted. Malformed, scalar, null, or list
frontmatter is synchronized byte-for-byte as opaque Markdown with `{}`
persisted fields; structured queries and field operations ignore its invalid
frontmatter until the document is repaired.

Application replicas resolve a stale record explicitly with
`resolveConflict(recordId, "local" | "remote")`. Keeping the local version
rebases it as a new idempotent mutation; keeping the remote version discards
only that record's queued mutations.

The in-process reference authority remains useful for deterministic contract
tests. Production uses `mdbase-connect-hosted-provider`: normalized encrypted
PostgreSQL storage, durable receipts and snapshot leases, and canonical
operation execution through `mdbase-rs`.

## Embedded mirror enrollment

Applications that materialize a remote collection into their own filesystem
can use the browser-approval client without copying the CLI workflow:

```ts
import { MirrorEnrollmentClient } from "@mdbase-dev/connect-sync/enrollment";

const client = new MirrorEnrollmentClient();

const enrollment = await client.enroll({
  controlUrl: "https://connect.mdbase.dev",
  mirrorName: "Obsidian vault",
  mode: "read_write",
  collectionId
}, {
  signal,
  onVerification: ({ verificationUri, expiresAt }) => {
    showApproval(verificationUri, expiresAt);
  },
  onStatus: ({ state, retryAt }) => {
    showEnrollmentStatus(state, retryAt);
  }
});
```

The client starts approval, polls until the user decides, validates the
selected collection and mirror mode, rejects an untrusted verification URI,
and returns the authority sync URL, replica identity, access token, renewal
credential, and expiries. `renew(enrollment)` rotates the short-lived access
token without changing the replica. When using `enroll()`, the verification
callback receives only public approval details; the short-lived enrollment
credential stays inside the enrollment flow.

The enrollment client deliberately does not persist credentials, mark a
folder, open a browser, or choose a filesystem. A host must keep the renewal
credential in device-local secret state, never in the mirrored collection.
Node hosts can use the profile and marker helpers from
`@mdbase-dev/connect-sync/device`, then construct `DirectoryMirror` or
`WritableDirectoryMirror` from `@mdbase-dev/connect-sync/node`. The enrollment
and portable mirror entry points have no Node dependency and can run in a
mobile host.

## Portable directory mirrors

`@mdbase-dev/connect-sync/mirror` contains the complete mirror state machine,
Markdown codec, collision preflight, durable mutation journal, reset handling,
and conflict resolution without importing Node filesystem, path, process, or
Buffer APIs. A mobile application supplies its own filesystem and durable-state
adapters:

```ts
import {
  DirectoryMirror,
  type MirrorFileSystem,
  type MirrorStateStore
} from "@mdbase-dev/connect-sync/mirror";

const mirror = new DirectoryMirror(replicaId, transport, {
  fileSystem: mobileVaultAdapter satisfies MirrorFileSystem,
  stateStore: deviceLocalState satisfies MirrorStateStore,
  lease: hostLifecycleLease
});

await mirror.sync();
```

The filesystem adapter deals only in collection-relative POSIX paths and
ordinary UTF-8 strings. The state store must live in device-local application
state, not inside the mirrored collection. A host should provide a lease that
excludes concurrent mirror owners for the same vault; the default memory lease
only protects overlapping calls in one JavaScript process.

Remote mirrors always materialize selected Markdown records and required
structural resources. They can additionally materialize images, audio, video,
PDFs, and other visible regular files according to an explicit per-device
policy. No file classes are selected by default. Dot-prefixed paths,
mdbase/Connect state, symlinks, unsafe hard links, portable path aliases, and
nested or configured exclusions remain outside the namespace regardless of
the selected media classes. A hosted `mdbase.yaml` can reserve collection
namespaces but cannot widen that device boundary with `record_extensions`.
Before any write, the portable core checks
resource and record revisions against exact document bytes, verifies parsed
record metadata, rejects duplicate stable identities, and rejects paths that
alias under Windows case rules or macOS Unicode normalization. Rust and
TypeScript exercise the same path-policy fixture corpus.

The desktop exposes these choices as a local projection. The CLI accepts the
same policy at enrollment and later configuration:

```bash
mdbase connect mirror add <collection-id> ./tasks \
  --files images,pdfs --exclude-folder Archive

mdbase connect mirror configure <replica-id> \
  --files images,pdfs --exclude-folder Archive
```

File snapshot and change metadata share the record cursor, while bytes travel
through the separately resumable file data plane. Hosted files are downloaded
through authenticated, revision-pinned ranges that recheck access before each
bounded read, then verified against their exact SHA-256 digest before
materialization.

The portable runtime uses audited JavaScript SHA-256 and `crypto.randomUUID`.
A host may inject `MirrorRuntime` to use an equivalent native primitive. The
Node entry point remains source-compatible and injects native hashing, atomic
filesystem writes, symlink/path-containment checks, device-local state, and a
cross-process lease.

This makes the engine mobile-safe; it does not force always-on mobile sync.
Obsidian or another host still owns background scheduling, battery/network
policy, secret storage, and translation from its vault API to
`MirrorFileSystem`.

### Performance and adversarial profiling

The repository keeps a source-commit- and runtime-identified
pre-quality-transformation 10,000-record baseline and checks both the Node and
portable adapters against it:

```bash
pnpm profile:mirror:check
pnpm check:mirror:mobile
pnpm profile:mirror:vault -- --source /path/to/large/vault
pnpm profile:mirror:writable-vault -- --source /path/to/large/vault
```

The regression check measures initial materialization, steady no-op sync,
100-record incremental receive, writable initialization, and writable no-op
sync across three rounds. It records wall time, peak/retained heap, filesystem
operations, state checkpoints, and transport calls. Stable operation counts
and bundle-size budgets are enforced in addition to timing/heap ceilings. The
receive-only heap gate includes a fixed, separately reported allowance for
snapshot-wide path, identity, revision, and document preflight; wall-time,
writable-mirror, I/O, and checkpoint limits remain tied directly to the
historical baseline. The
live-vault harness uses a disposable target, injects divergence, update,
rename, delete, create, and a collision on the final snapshot path, then
verifies no partial initialization state was committed. Unit coverage injects
adapter failure and snapshot-boundary corruption before durable state advances.

If a request fails transiently while approval is pending, the client retries
until the server-provided deadline. Cancellation, expiry, malformed responses,
collection substitution, mode substitution, and permanent server errors fail
with a stable `MirrorEnrollmentError.code`.

## Command line

```bash
# Recommended: approve the folder in a browser and sync both ways
mdbase-mirror connect ./tasks --server https://connect.mdbase.dev \
  --collection <collection-id>

# Receive-only browser enrollment
mdbase-mirror connect ./tasks --server https://connect.mdbase.dev \
  --collection <collection-id> --read-only

mdbase-mirror sync ./tasks
mdbase-mirror status ./tasks
mdbase-mirror resolve ./tasks <record-id> --use local

# Move authority from mdbase cloud to this computer
mdbase-mirror promote ./tasks
```

`connect` creates a short-lived browser approval request. The resulting
collection-scoped access and renewal credentials are stored in the device's
owner-only application-state directory, never inside the mirrored folder.
Access tokens renew automatically until the mirror is revoked.

The folder contains only a non-secret `.mdbase/connect-role.json` marker that
identifies it as a mirror. A local Connect agent will not register or
relay that folder. Mirror operations also use an exclusive device-local lease;
`watch` holds it for its lifetime, so a desktop mirror and an Obsidian mirror
plugin cannot run over the same physical folder. The lock namespace is shared
per OS user and is independent of each client's credential/state directory.

`promote` requires a converged, full writable mirror and a running local
`mdbase-connect` agent. It opens a browser confirmation, freezes hosted writes
at a final sequence, proves that the directory is exact, and registers the
folder locally under the collection's stable ID. Completion advances the
authority epoch and revokes the old hosted replicas and application grants.
Before cutover, cancellation or expiry restores hosted writes. If the command
is interrupted after local registration, run it again to resume completion.

The lower-level `init` command remains available for automation and migration.
It reads a pre-provisioned token from a hidden prompt or
`MDBASE_CONNECT_REPLICA_TOKEN`.

Configuration and type documents are materialized but never uploaded as
ordinary records. Writable changes use base revisions and a durable mutation
journal. A concurrent edit isolates only the affected record while unrelated
records continue synchronizing. `status` identifies the records that need an
explicit local or remote choice. When a writable mirror connects an existing
directory, the first sync compares the complete remote snapshot before writing
or uploading anything. Differing paths stop for explicit review; matching
Markdown keeps its local file and previously unmanaged Markdown is uploaded.
Formatting of an accepted local upload is not rewritten when the mirror
replays its own authority event.

## Portable authority adoption

`@mdbase-dev/connect-sync/adoption` can move a portable collection snapshot into a
hosted authority without routing binary bytes through the Connect control
service. Include file descriptors in the snapshot and resolve their bytes
lazily with `fileSource`:

```ts
import {
  AuthorityAdoptionClient,
  buildPortableAuthoritySnapshot
} from "@mdbase-dev/connect-sync/adoption";

const snapshot = buildPortableAuthoritySnapshot({
  collectionId,
  specVersion: "0.3",
  resources,
  records,
  files
});

await adoption.uploadSnapshot(session, prepared, snapshot, {
  fileSource: (file) => localFiles.get(file.file_id)!,
  onFileProgress: ({ file, transferredBytes, totalBytes }) => {
    report(file.path, transferredBytes, totalBytes);
  },
  signal
});
```

`fileSource` may return a `Blob`, `ArrayBuffer`, or typed-array view. The client
hashes and validates each source, resumes from authority-reported parts, uses a
single prepared PUT or multipart upload as appropriate, and commits only after
the hosted provider has verified the complete R2 object. The manifest, file
identity, upload intent, progress, versions, and activation state remain
transactional PostgreSQL data; immutable bytes remain in R2.
