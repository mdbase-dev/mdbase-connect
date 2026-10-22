# Native contract digest producer

`native-contract-digests` is an offline, generic semantic-pin producer. It uses
this crate's real native FileStore/SQLite/LocalReplica composition and ordinary
`ClientApi.describe`; it does not run a daemon or use a synthetic catalog.

```sh
native-contract-digests \
  --manifest app-manifest.json \
  --bundle schema-bundle.json \
  --work-root ./new-isolated-directory \
  --contract example.source@1.0.0 \
  --contract example.annotation@1.0.0
```

The parent of `--work-root` must already exist. The root itself must not exist:
the tool never adopts an existing collection. It creates only an isolated
local-only identity/store, leaving that folder available for inspection. Close
and resource readback precede output; callers own subsequent folder cleanup.
No account, CP, network, browser or existing application session is involved.

## Inputs

- An exact version-one app manifest with `id` and `requirements.contracts`
  entries containing exact `id`/`version` pairs.
- An exact UTF-8 JSON bundle:

```json
{
  "schema": "mdbn-native-schema-bundle/1",
  "resources": [
    {"path": "mdbase.yaml", "document": "spec_version: '0.3.0'\n"},
    {"path": "_contracts/example.md", "document": "...exact definition source..."}
  ]
}
```

Supply the real configuration, definitions and referenced schema resources.
No default config, path aliases, schema rewriting or Markdown reconstruction is
provided. Native parser/compiled-schema preflight rejects invalid catalogs.
The fresh native store receives all definitions in **one ordinary engine
resource batch**, with one original mutation ID and create-only resource writes.
The engine resolves references against its complete staged registry and publishes
the exact documents; the tool does not pre-write definition files or retry a
refused/unknown attempt. Final values come only from native Describe after a
confirmed, published, conflict-free receipt, exact resource readback and exact
physical-file readback. A source the runtime did not admit fails the operation.

Without `--contract`, every manifest requirement is selected. Repeated selectors
must be distinct exact manifest-declared pairs. A subset is explicitly reported
as `completeManifestContractSelection: false`; it is never full-manifest readiness
or permission to ignore an unsupported requirement during application setup.
The tool does not validate app authorization, manifest signatures or setup plans.
Manifest-declared digests are not an oracle for the emitted native values.

## Output and provenance

Only a complete success writes one JSON report to stdout. Refusals write a
reason to stderr and exit nonzero, without partial pins. Each tuple carries
native `id`, `version`, `contractType`, definition path, implementing types and
actual Describe `wire.Hash`: lowercase 64-digit `digest` plus the identical
32-byte `digestBytes` array. These are semantic contract hashes, not raw source
or schema-file hashes.

Provenance separately records SHA-256 of the exact manifest bytes, exact schema
bundle bytes, every admitted resource, the actual executing native binary
(containing the compiled engine), and the producer source bytes embedded at
compile time. Git/release/build-toolchain provenance and authenticated artifact
packaging belong to the release owner; this source tool cannot certify them.
The report includes the actual native hello semantics and catalog spec version.
`bootstrap` records the original mutation ID, resource count and exact native
receipt CBOR bytes; it is not a synthesized confirmation or a remote log receipt.

This qualifies only the specified native parser/compiled-schema/SQLite/Describe
inputs. It is not a WASM pin, compatibility claim for another engine artifact,
whole-app setup/readiness, native app authorization, browser or durability proof.
Consumers must compare the qualified tuples to their actual native catalog and
retain exact compiler/artifact/input provenance.

## Bounds and qualification

Manifest ≤1 MiB; bundle ≤8 MiB; 1–64 resources and selected contracts; each
resource ≤1 MiB; portable path ≤4096 UTF-8 bytes. JSON depth ≤32/nodes ≤65536;
output ≤1 MiB. Executable provenance hashing reads at most 256 MiB. These are
input/read/output bounds, not a measured peak-heap or parser CPU certificate.
Paths cannot traverse, alias, address a native private directory or use a drive
prefix. Missing/duplicate/unadmitted resources and incomplete selections refuse.

The focused native integration tests use Reader's exact published manifest.
The complete eight-resource bundle qualifies all three manifest contracts:
source/annotation beta1 and the nested `mdbase.view` 1.0.0 contract with its
external JSON Schema. This is complete **native tuple selection**, not app setup
or WASM readiness. The selected five-resource bundle remains explicitly a subset;
default full selection with that incomplete bundle still refuses.

The earlier disk-only staging refusal was a resource-bootstrap dependency cycle,
not an unsupported nested contract or view schema. The producer uses the atomic
engine resource-batch path independently of filesystem discovery.

### Filesystem resource bootstrap

Local-only and signed-sync filesystem discovery also stages configuration,
observed definitions and their Core-normalized schema references together before
ordinary records. It compiles the complete confirmed-plus-pending registry and
captures one native resource mutation through the existing planner/publication
pipeline. An external schema can be read as bounded UTF-8 from its original live
attachment observation only when a definition declares that dependency; ordinary
JSON files remain attachments. Resource moves and deletions retain the existing
planner and publication checks.

Missing, malformed, changing or over-budget dependencies defer the set without
acknowledging its observations. FileStore reoffers eligible stable evidence with
its original tokens and bases, not fresh attempts. A bounded redelivery prefix
cannot silently accept a partial deferred resource set. The next observed file
change or dependency arrival can complete it. Host status records deferral;
retained input files are not themselves proof of an admitted catalog. A terminal
native capture refusal retains its original mutation/set binding in a bounded
live-session cache; unchanged redelivery cannot mint another attempt. Changing
actual observed input creates a new set, not a retry of an unknown original.

The prepass bounds inventory to 1024 resources, resource operations to 64,
retained sources to 8 MiB, each document to 1 MiB and paths to 4096 bytes, with
bounded reference-search work. These are not peak-heap or CPU certification.
Native tests cover complete and staggered filesystem inputs. A shared Rust
queued-publication model exercises the generic Replica prepass, and the portable
WASM target compiles. Neither check executes the Obsidian runtime's asynchronous
FileStore driver or establishes actual WASM/app acceptance or browser durability.

### Retained queued observation scans

`FileStore::start_observe` owns one original scan future and exclusively borrows
the store while host IO suspends. No partial observation batch is returned;
native `Store::observe` uses the same implementation for immediate platforms.
The host retains/polls this owner and drains original operations before releasing
filesystem ownership. Missing/quiet windows start at actual IO completion, not
before a potentially long host suspension. Mirror closure refuses further scan
requests and delivery; required range-handle cleanup still drains.

Queued Rust tests scan all eight unchanged physical input files and verify
original IO IDs, complete text/digest observations, retained Rescan after a host
refusal, original-token redelivery after partial capture refusal, captured caller
paths and the delayed missing-file window. Observation alone does not ACK files
or admit a catalog. This is not async Replica resource ingestion/publication,
real TS HostLoop/FileStore integration, Obsidian execution or durability proof.

### Retained resource-source ingestion

Object-safe `Store::observe_async` and resource text/currentness/complete-set
hooks retain original operations while IO suspends; immediate native defaults
preserve synchronous results. `Replica::observe_async` / `ingest_async` use the
same registry closure and capture path as their native convenience methods.
Keep the original future alive until completion: pending exclusively borrows the
engine, does not acknowledge a prefix or expose a partially compiled catalog,
and dropping it is not host-IO cancellation/drain acknowledgement. Native
convenience methods are for immediate stores, not a queued-host polling loop.
Live store-health and mirror gates still fence capture after suspension.

Queued Rust source-hook tests verify all eight exact physical documents through
FileStore/SQLite and original IO IDs, including a hidden live resource rejecting
a prefix and a source changed during a pending read. Separate Replica/Core toy
store tests suspend source reads, complete-set and final currentness fences and
check unchanged tokens and one registry capture. The toy publication completion
is not physical async publication. These tests do not jointly qualify real TS
HostLoop/FileStore startup, admission, publication or write/read round trips;
publication remains an independent lifecycle slice. No Obsidian or durability
qualification is implied.

### Retained commit/publication foundation

`FileStore::start_commit` owns the original transaction and retains its evidence
ACK, expectation reads and shared publish-strategy futures while host IO
suspends. Native `Store::commit` runs this same orchestration immediately.
Original intent counters, private names, bytes and CAS remain unchanged through
suspension. Live admission fences each publish primitive before enqueue and
after completion; acquired lock/range handles still drain if admission closes.
Failed or uncertain publication keeps its original recovery intent. Dropping a
pending owner is not host-IO cancellation/drain acknowledgement: metadata/head,
observation and subsequent commits refuse until reopen. Do not restart it.

Queued Rust/SQLite/physical-file tests cover create/replace/two-phase move/delete,
changed-source CAS drift, original intent retention through a refused flush and
recovery, late mirror closure and abandoned-owner fencing. A seeded evidence
fixture tests actual physical cleanup and persistence of its original obligation
until completion; the fixture is not a signed-log/recovery provenance proof.
This foundation does not install Replica deferred-batch/progress integration or
qualify joint TS HostLoop/FileStore, Obsidian, app or power-loss acceptance.

### Explicit queued publication/progress

Set `Config::queued_publication` explicitly for a suspending platform. The native
default remains immediate. `Store::commit` applies the original inner transaction
ONCE, returns its original deferred publication batch and starts no host IO. Retain
`FileStore::start_progress`, poll it with actual host time and complete each
original operation. Release the completed owner, then call the existing
`Replica::on_store_progress` to consume results. Never rebuild/recommit a pending
transaction. Required evidence ACK-only cleanup is FIFO work, not a fabricated
publication batch; no result is exposed ahead of required cleanup or failed IO.

Accepted owned work is precharged before inner rows/ACK effects: at most 64 queued
or unconsumed result slots, 1024 publication/ACK operations, 8 MiB charged payload,
1 MiB per text source and 4096 UTF-8 bytes per path. Drift results retain their
original charge until consumption. Blob publication requires a pre-existing,
bounded local cache source and retains its exact digest-verified original bytes;
a later cache deletion cannot replace that source. These are accepted ownership
bounds, not peak heap/allocation/CPU or power-loss guarantees. Snapshot reset is
refused until original work/results drain. Failed/abandoned work fences further
progress/metadata/head; reopen is required, with original recovery intents kept.

Joint Rust tests now use real queued FileStore, SQLite, local-only Replica and
physical files: completed original eight-resource startup Rescan, three native
compiled contracts, an original caller UUID/MID, pending publication before host
IO, one original intent, confirmed receipt after the existing progress hook,
genuine full-document/revision readback and exact physical bytes. A refused flush
keeps original intent/MID and never reports published. This is not signed-sync,
real TS HostDriver/HostLoop/VaultPlatform, Obsidian, app or durability acceptance.

### Joined TS host / native FileStore qualification

The qualification-only `queued-ts-host-proof` example retains actual native
FileStore/SQLite/local-only Replica owners. Its bounded, owned Linux FIFO fixture
adapts original HostQueue requests/completions and actual polling to the existing
TS QueuedCore interface. The explicit Node runner uses the real HostLoop,
HostDriver and VaultPlatform, with the bounded whole-file provider and an owned
physical filesystem adapter. This is not a public RPC, WASM binding or plugin.

The runner requires freshly compiled native and TS source artifacts; missing
artifacts fail rather than silently skip. It checks completed startup Rescan,
eight exact original resources, three compiled native contract digests, original
UUID/MID and captured pre-IO receipt, stable original intent bytes, terminal
publication through the existing progress hook, confirmed unprotected native
readback and exact physical bytes. Original operation IDs never restart and all
required work drains before host/child shutdown. A separate genuine outside
physical writer wins the original guarded-create race; the same original MID is
NotPublished and outside bytes remain untouched. Failed fixture transport never
manufactures completion or drain acknowledgement. Evidence is retained under the
owned fixture root. This qualifies source-built Linux TS-host/native local-only
integration, not actual Obsidian, signed synchronization, application acceptance,
a released WASM artifact, performance/heap bounds or power-loss durability.

From the repository root, after building the SDK and obsidian-runtime packages
from this checkout:

```sh
cargo build -p mdbn-local-host --example queued-ts-host-proof
node --test packages/obsidian-runtime/test/qualification/fileHostStartup.node-test.mjs
```

Contributor checks:

```sh
cargo test -p mdbn-local-host --test resource_bootstrap -- --nocapture
cargo test -p mdbn-local-host --test semantic_digests -- --nocapture
cargo clippy -p mdbn-local-host --bin native-contract-digests --test semantic_digests -- -D warnings
```
