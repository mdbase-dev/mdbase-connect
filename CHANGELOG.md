# Changelog

## 0.1.0-beta.67

Beta.67 restores hosted-authority query compatibility while keeping
generation-pinned cursor pagination as the preferred SDK path.

- The SDK now treats its first automatic cursor request as a read-only
  capability probe. If an authority rejects the optional pagination field, it
  retries that first page with legacy offset pagination and keeps later pages
  on the legacy path.
- Explicit cursor requests remain strict: they are never silently downgraded,
  so callers asking for generation-pinned semantics still receive the
  authority's typed incompatibility response.

## 0.1.0-beta.66

Beta.66 hardens the coordinated runtime introduced in beta.65 against
non-semantic filesystem churn, removed-collection races, and recoverable object
storage rejection during multipart upload.

- The provider classifies watcher events before reconciliation. Hidden files,
  cache and migration paths, configured exclusions, disabled subfolders, and
  non-record binaries no longer rebuild a large collection snapshot; metadata,
  schemas, contracts, and record resources retain exact reconciliation.
- Watcher snapshot loading is side-effect-free, leaving durable transaction
  recovery with the coordinated runtime instead of racing settlement on an
  observer thread.
- Collection removal now crosses a synchronous watcher lifecycle barrier before
  registry deletion, while failed refreshes restore active state. Mirror
  residency owns at most one abortable worker per replica and cancels it when
  the replica is no longer actionable.
- Multipart object uploads retry transient or authorization failures with a
  fresh presigned URL for the same idempotent part number. Invalid progress
  reports privacy-safe state and counts instead of opaque payload data.

## 0.1.0-beta.65

Beta.65 makes one coordinated mdbase runtime the local execution owner for
each active collection and removes the duplicate Connect watcher and mutation
invalidation paths.

- The provider now returns exact generation-bound execution outcomes, owns
  durable prepare/commit/cancel settlement and a pull/ack change feed, applies
  sparse record mutations, and maintains its rebuildable cache and reverse-link
  index incrementally.
- Connect gives each resident collection separate bounded mutation,
  foreground-read, and background lanes. Known mutations and external edits
  enter one durable ordered change path, and post-commit work remains owned
  after the caller's deadline.
- Runtime residency is bounded to eight idle/active collection handles;
  inactive runtimes can be evicted and reopened from canonical Markdown without
  changing collection identity or grants. Privacy-safe diagnostics expose only
  aggregate resident state and retained snapshot bytes.
- The SDK coordinates requests once per selected connection, keeps a reserved
  ordered mutation lane, bounds foreground pressure, coalesces only safe reads,
  and supports explicit latest-wins query families.
- Query iteration uses opaque generation-pinned cursors when supported, releases
  cursor leases on early exit, and retains the legacy snapshot/offset path for
  older staging-compatible authorities.
- The hosted mirror transport has bounded connect, read, and whole-sync
  deadlines so a stalled binary transfer releases its mirror guard and resumes
  through durable journal recovery.

## 0.1.0-beta.64

Beta.64 keeps large local and relayed collections inside one explicit resource
boundary while preserving foreground and durable-mutation capacity under load.

- Local control, encrypted loopback, and relay operations share bounded
  admission and stable collection-read workers; foreground, background, file,
  and mutation work retain independent global and per-grant limits.
- Read capacity remains held through serialized response delivery, preventing
  slow WebSocket, loopback, or local-socket consumers from multiplying large
  retained bodies after execution has nominally completed.
- Cooperative read cancellation observes deadlines between bounded engine,
  sync, inventory, and file phases. Timeout and durable mutation entry meet at
  one atomic boundary so `not_sent` remains provable and post-boundary work is
  recovered by exact request replay.
- Idempotent upload-open and transfer-abort housekeeping no longer scans the
  complete collection for mutation evidence; collection-changing file
  operations retain manifest evidence.
- Upload-open replay safely recovers an empty regular staging file left by a
  crash before transfer-row insertion and rejects unsafe or non-empty orphans.

## 0.1.0-beta.63

Beta.63 makes execution deadlines truthful for durable mutations and preserves
their exact recovery identity across every SDK transport outcome.

- A relayed or direct durable mutation that outlives its caller's execution
  deadline now returns `operation_outcome_unknown` instead of the incorrect
  `operation_cancelled` / `not_sent`; queued work and reads retain their
  cancellable `not_sent` semantics.
- The SDK retains pending mutation state when either an HTTP authority response
  or an encrypted connector receipt reports an unknown outcome, then recovers
  with the same request ID, counter, ciphertext, operation, and payload while
  refreshing only the unauthenticated scheduling deadline.
- SDK-side deadlines after mutation dispatch also become unknown outcomes,
  while pre-dispatch cancellation remains definitively `not_sent`.
- Aborted framed file downloads preserve typed `operation_cancelled` results
  even on runtimes that surface an aborted fetch as `TypeError`.

## 0.1.0-beta.62

Beta.62 bounds collection-query memory and connector admission under load while
preserving capacity for interactive reads and mutations.

- Metadata-only typed queries page through the engine cache instead of
  materializing the full collection, and expired queries stop cooperatively
  during cache refresh, snapshot loading, and record evaluation.
- Direct and relayed work share one bounded scheduler with per-grant limits,
  reserved mutation capacity, foreground read capacity, per-collection
  mutation serialization, and count- plus byte-bounded queues.
- SDK requests carry an optional absolute deadline that can only shorten the
  connector's local execution window; it remains outside durable replay
  identity so retry and recovery semantics do not change.
- The control plane bounds pending encrypted operations by grant, connector,
  process count, and retained request bytes while policy and control traffic
  retain dedicated capacity.

## 0.1.0-beta.61

Beta.61 makes hosted-provider readiness acyclic while retaining an exact,
operator-visible account of durable notification recovery.

- Provider readiness now covers only the authoritative database, blob store,
  and key hierarchy; retryable notification callbacks no longer keep Connect
  and its provider waiting on each other or trigger a platform restart loop.
- Startup attempts notification recovery without making callback availability
  a process-start dependency, and the background worker safely replays the
  same durable invocation after the control plane recovers.
- Recovery is single-flight and reports `pending`, `degraded`, or `ok` from the
  actual durable outbox and runtime state, with privacy-safe transition metrics
  and no false healthy result from an overlapping or lease-blocked sweep.

## 0.1.0-beta.60

Beta.60 keeps large local collections responsive while binary files are served
and makes bounded connector backpressure recoverable by applications.

- Opening one indexed download no longer reconciles or hashes the rest of the
  vault; the selected snapshot is still copied and digest-verified before any
  bytes are released.
- Stale paths are resolved with a metadata-only identity scan so authorization
  is rechecked against a file's current path without restoring whole-vault work
  to the request path.
- Connector overload is an explicit `503` with `Retry-After`; the SDK applies
  deadline-bound jittered backoff, reuses exact mutation envelopes, refreshes
  read envelopes, and never retries unknown mutation outcomes.
- File chunks use bounded retry backoff long enough to bridge a desktop daemon
  restart while preserving cancellation and integrity checks.

## 0.1.0-beta.59

Beta.59 makes legitimate large relay operations independent of the broker's
per-message payload ceiling.

- Relay requests and responses use bounded, versioned fragmentation below the
  active NATS `max_payload`, with strict logical-message and aggregate-memory
  limits, assembly deadlines, and malformed-frame rejection.
- JSON operations and opaque binary file frames share the same transport, so
  large collection listings and file traffic cannot terminate a Connect server.
- Multi-instance relay coverage now exercises requests and responses above the
  broker ceiling, concurrency, connector fencing, disconnects, and recovery.

## 0.1.0-beta.58

Beta.58 closes two staging findings from the beta.57 compatibility rollout.

- Connector control snapshots include the exact signed declaration, manifest,
  and protocol contracts required to deserialize and install active grants.
- Cold or changed binary indexes warm once outside the relay request path;
  stable files reuse verified digests, and exact downloads still verify the
  selected bytes before delivery.
- The SDK retries typed index-warming responses under a dedicated file-index
  budget instead of leaving a timed-out relay request hashing in the daemon.

## 0.1.0-beta.57

Beta.57 adds a bounded migration bridge for durable beta.55 work while keeping
transport v3 as the only current request path.

- Authorization binding v5 signs an explicit mutation-only v2 recovery
  contract; ordinary reads and new mutations cannot silently downgrade.
- Frozen beta.55 v4 and transport-v2 fixtures preserve exact interoperability,
  including durable legacy-read receipts across connector restarts.
- Existing hosted replicas expand safely and are reconciled to their exact
  signed transport policy before the compatibility window contracts.
- Privacy-minimal protocol telemetry and fail-closed readiness gates make v2
  and v4 removal depend on observed use and remaining recovery contracts.

## 0.1.0-beta.56

Beta.56 isolates local authorization from application data-plane load and
introduces the coordinated transport-v3 replay contract.

- Policy, grants, admission counters, and mutation recovery move to a bounded
  single-writer `authority.sqlite` store.
- Exact mutation responses use immutable, content-addressed receipt files;
  ordinary read responses remain only in a byte-, count-, and age-bounded cache.
- SDK reads retry once with a fresh encrypted request after route uncertainty or
  cache loss, while mutations retain their exact recoverable envelope.
- Relay policy installation is ordered off the socket loop with bounded queues,
  reserved control capacity, and typed overload responses.

## 0.1.0-beta.55

Beta.55 hardens portal authorization startup, hosted record mutations, and
editor projection consistency.

- Portal auth fragments are captured before the first render.
- Hosted record preflights are separated from mutation execution.
- Editor projections rebase after source saves.

## 0.1.0-beta.54

Beta.54 makes application startup safe for large hosted collections when the
requested collection setup is already current.

- Current setup assessments no longer clone the complete collection into a
  temporary preflight workspace.
- Applicable setup changes still use the existing staged, revision-safe
  transaction path.

## 0.1.0-beta.53

Beta.53 requires application sessions that request full-collection access to
hold a matching full-collection grant.

- Contract-scoped grants no longer satisfy full-collection application
  requirements and trigger renewed authorization.
- Contract-scoped application requirements continue to work with
  contract-scoped grants.

## 0.1.0-beta.52

Beta.52 removes avoidable latency after a file download has already completed
and passed integrity verification.

- Browser clients expose verified file bytes immediately while best-effort
  transfer cleanup continues outside the document-loading critical path.
- Cancellation and failed downloads still wait for cleanup, preserving the
  existing recovery and integrity guarantees.

## 0.1.0-beta.51

Beta.51 improves resilience under local registry contention and reduces file
download latency.

- Relay operations distinguish retryable SQLite contention from rejected
  requests and report that the operation was not sent.
- Connector watchers batch registry writes to shorten transactions and reduce
  lock contention while preserving operation ordering.
- Framed file downloads prefetch subsequent chunks without changing integrity
  verification or retry behavior.

## 0.1.0-beta.50

Beta.50 makes application authorization independent from collection repair and
keeps collection-setup failures actionable.

- Applications that require no collection setup can be authorized even when
  unrelated existing records have validation errors.
- Required setup compares staged diagnostics with the collection baseline,
  preserving existing errors while rejecting errors introduced by the setup.
- Connector diagnostics now survive the relay and appear in the portal with
  their affected collection path while the selected collection stays in place.
- The editor development deployment has a documented, verified staging helper.

## 0.1.0-beta.49

Beta.49 gives new accounts a useful first collection and sends them directly
into the mdbase editor.

- Invitation signup provisions a small hosted starter collection from a
  versioned Markdown template, with an idempotent recovery path if provisioning
  is interrupted.
- The post-signup handoff opens the starter collection in the editor, where its
  notes explain collections and the next ways to build with mdbase.
- Writer mode renders Markdown and wiki links as readable links while preserving
  source editing, and empty type views use a clearer centered state.
- Hosted storage refuses insecure non-local R2 endpoints, and release builds
  reuse Rust and BuildKit caches to shorten beta delivery time.

## 0.1.0-beta.48

Beta.48 adds a safe recovery path for invitations affected by the beta.47
signup incident.

- Managed invitation resends can use a recovery-only transactional template
  that apologizes for the failed signup and delivers the fresh one-time link in
  the same email.
- Recovery resends retain the invitation entitlement, invalidate the previous
  link, omit credentials from operator output, and identify the email template
  in the operator result and audited reason.

## 0.1.0-beta.47

Beta.47 repairs invitation account creation and email delivery tracking for the
invite-only beta.

- Invitation acceptance now locks only the invitation row before creating the
  account, avoiding PostgreSQL's prohibition on locking the nullable side of an
  outer join while retaining single-use invitation semantics.
- Resend delivery webhooks use contiguous PostgreSQL parameters, allowing
  delivery, bounce, suppression, and complaint events to update email state.
- The account creation form no longer suggests connecting Google later.

## 0.1.0-beta.46

Beta.46 separates hosted replica storage allowances and repairs Google account
linking for invited beta accounts.

- Hosted account quotas now distinguish primary hosted collections from local
  replica slots, including independent entitlement limits and migration of
  existing account data.
- Google Identity Services receives the relying-party origin from both Connect
  and Editor, and trusted editor callbacks can complete account linking.
- Invited people create their account through the one-time password link, may
  connect Google afterward, and can use that linked identity for later sign-in
  without opening registration to matching email addresses.

## 0.1.0-beta.45

Beta.45 makes pre-existing application definitions reviewable and completes
the beta.44 application-setup hotfix.

- Collection setup can carry exact, digest-pinned consent to adopt a managed
  definition that already exists without a type-pack receipt. The SDK prepares
  that review automatically, so application update buttons are enabled without
  silently changing the collection.
- Hosted and local approval retry the reviewed setup with those exact digests.
  Files owned by another pack, seed definitions, and definitions changed after
  installation remain conflicts; a change between review and apply is rejected.

## 0.1.0-beta.44

Beta.44 is a managed-service hotfix for application setup and hosted MCP
authority access.

- Application approval now applies the complete setup the user reviewed,
  including managed updates and auxiliary type packs when a collection already
  provides the required contract. The portal names every declared definition
  pack, and the application SDK performs only one initial setup assessment.
- The MCP gateway retains each hosted grant's signing key and signs both
  provider operations and refresh-token exchanges. Hosted collection calls no
  longer fail immediately with a provider 401 or misleading `invalid_grant`.
- Closed-registration login pages link people without an invitation to the
  beta access request page.

## 0.1.0-beta.43

Beta.43 completes the coordinated beta.42 desktop release without changing the
sync protocol or runtime behavior.

- Large, deterministic sync fixtures now use platform-neutral completion
  guards. Exact chunk, download, cache, read, write, and stable-state
  assertions remain the performance contract, while slower release runners no
  longer turn healthy work into wall-clock-only failures.
- The macOS Intel release regression suite and every supported desktop smoke
  test pass with the same plan-only sync engine shipped in beta.42.

## 0.1.0-beta.42

Beta.42 makes native startup deterministic when the operating-system
credential service is locked or slow and completes cross-platform release
verification for the beta.41 sync architecture.

- Credential bootstrap has a strict two-second deadline. An unavailable store
  enters an explicit offline mode that keeps local control responsive, disables
  direct application access, and returns typed errors for secret-dependent
  operations instead of hanging or repeatedly retrying.
- Watcher and relay initialization run as an owned background startup task.
  Local status is immediately available with `ready: false` until initialization
  finishes, and shutdown still cancels the worker cleanly.
- Desktop release portability tests accept native Windows CRLF checkouts while
  preserving the same Rustls provider-ordering assertion on every platform.

## 0.1.0-beta.41

Beta.41 completes the prerelease conflict workflow and the native runtime
hardening found during packaged and live Obsidian testing.

- Writable initial same-object divergence is a durable, nonblocking conflict,
  so independent actions can proceed while path-ownership, read-only, and
  resource collisions continue to fail closed.
- Record and binary-file conflicts now share one entity-aware status and
  resolution protocol. Every choice echoes a semantic decision token and is
  applied only while both the local bytes/path and hosted snapshot still match
  the reviewed conflict; stale choices require a fresh inspection.
- Conflict inspection refreshes changed exact states and clears natural
  convergence through an explicit plan action. File resolution preserves
  stable identity across exact byte changes, moves, and deletions.
- The desktop and native daemon share the same local-control protocol contract,
  and the Rust workspace installs one explicit TLS crypto provider before any
  client construction.

## 0.1.0-beta.40

Beta.40 completes the operational hardening found while upgrading and live
testing beta.39's exact-document sync engine.

- Incompatible prerelease mirror state is identified from its minimal version
  envelope before current-schema decoding, so upgrades fail at the deliberate
  rebuild boundary rather than at an incidental nested field.
- A blocked legacy mirror no longer hides healthy replicas or retries forever;
  list results isolate its structured error and background scheduling waits for
  operator rebuild.
- An exact idle incremental inspection is now a stable empty plan. Applying it
  performs no journal, checkpoint, cache, generation, timestamp, or durable
  state write, while real cursor advances and effectful plans still checkpoint.
- Tag-triggered npm and desktop publishers may be manually rerun against the
  exact existing tag after an Actions outage.

## 0.1.0-beta.39

Beta.39 deliberately rewrites the unreleased sync-v1 contract around exact
documents and one reconciliation owner. Existing prerelease mirrors must be
rebuilt; there is no dual-format compatibility path.

- Record and resource revisions are SHA-256 over exact UTF-8 document bytes.
  BOMs, line endings, comments, key ordering, nulls, malformed frontmatter,
  trailing spaces, and bodies survive authority and mirror round trips.
- Raw replication uses only conditional `put`, `move`, and `delete`. A move
  preserves identity and every document byte and never rewrites references;
  semantic rename remains an explicit mdbase operation.
- TypeScript and Rust mirrors now inspect both sides into a sorted,
  content-free plan, revalidate its fingerprint, and apply one durable batch.
  Obsidian and the native CLI consume that plan instead of calculating another
  preview.
- Expected collisions, conflicts, resource drift, cancellation, and stale
  review are explicit outcomes. Fresh status is inspection-backed, while the
  cheap checkpoint view makes no remote-freshness claim.
- Shared portable-path fixtures cover platform-reserved punctuation and
  physical aliases. Lost replies, restart, byte-odd Markdown, raw moves,
  binary echoes, stale plans, and side-effect-free inspection have regression
  coverage.
- The hosted beta migration retires wrapper-shaped records and replay state
  while preserving collection identity, replicas, resources, files, quotas,
  notification grants, and the shared sequence head. This is the explicit
  prerelease reset boundary, not a hidden dual-format decoder.

## 0.1.0-beta.38

Beta.38 restores correct logical-array semantics for editable Obsidian Bases
saved views. In particular, TaskNotes Today views now interpret their nested
`or` filter correctly and retain date-only tasks scheduled for the current day.

## 0.1.0-beta.37

Beta.37 makes calendar semantics explicit across local, hosted, and application
execution without changing the published protocol-version constants.

- Queries and saved-view executions accept an ephemeral IANA timezone, and the
  SDK carries it end to end without rewriting persisted views.
- Every new local or hosted collection captures its creator's IANA timezone as
  durable authority configuration; invalid aliases and numeric offsets fail
  before collection creation.
- Local and hosted notification runtimes use the collection authority timezone
  for headless calendar evaluation.

## 0.1.0-beta.36

Beta.36 simplifies the application access decision without changing the
authorization protocol or collection semantics.

- Requests with several compatible collections now require an explicit
  collection choice before access can be reviewed.
- The default review summarizes concrete capabilities and keeps delete and
  collection-structure access visible while exact operations remain editable.
- Mandatory type and configuration setup is described as a collection change;
  expert identifiers and meaningful type-mapping choices remain available on
  demand.
- In-progress collection and permission choices survive a browser refresh for
  the lifetime of the authorization request.

## 0.1.0-beta.35

Beta.35 is a production hotfix for application approval against hosted
collections. It preserves beta.34's authority contracts and data formats.

- Hosted notification grants now carry the exact declaration identity and
  manifest digest already bound into the signed application authorization.
  This fixes approval for applications such as TaskNotes that declare hosted
  notification criteria.
- Rust and TypeScript grant summaries now require the same application identity
  fields, so an incomplete control-plane payload fails at build time.
- Safe hosted-provider validation failures retain their HTTP 422 status and
  structured problem instead of being reported as a generic storage failure.

## 0.1.0-beta.33

Beta.33 is the single successor to the undeployed beta.32 candidate. It retains
beta.32's operation transport v2, authorization binding v3, semantic capability
v1, and durable-mutation v1 contracts while deliberately breaking the
application-facing SDK surface one final time before external beta. Supported
beta.28+ data remains migration-safe; beta SDK compatibility is not preserved.

### Final SDK surface and lifecycle

- Application-facing inputs, results, and progress events consistently use
  camelCase while protocol payloads remain canonical snake_case at the
  boundary. User-owned frontmatter keys are never renamed.
- `MdbaseApplicationSession.start()` is concurrency-safe and idempotent across
  repeated starts, cancellation, failure, destruction, and framework remounts.
  Composite operations consume one monotonic request budget rather than
  restarting or dropping the caller's timeout.
- The root package now exposes a reviewed golden-path API. Protocol-author and
  cryptographic seams live on explicit subpaths, while supported outcome/fault
  builders live in `@mdbase-dev/connect-testing`. The untyped ordinary
  connection operation escape hatch and internal construction helpers are no
  longer public.
- Query/filter/order inputs are precisely typed from the canonical operation
  contract. Packed positive and negative fixtures enforce root, `/advanced`,
  `/crypto`, and testing boundaries, and every public example compiles.

### Application-declared collection setup

- Applications can declare required collection configuration, contracts, and
  type packs. Local, relay, and hosted authorities use the same canonical
  mdbase-rs assess/apply semantics, exact review digests, conflict reporting,
  idempotent receipts, and atomic setup transaction.
- Authorization binds setup to the reviewed application declaration. Generic
  collection templates remain application-neutral; existing collections adopt
  requirements without recreation or blanket template migration.

### Performance and packaging

- Hosted working sets maintain paired path/record indexes and use an explicit
  caller-owned staged-mutation boundary. Ordinary filesystem mutations retain
  mdbase-rs's collection-wide atomic shadow transaction, while hosted writes
  rely on their disposable stage plus outer PostgreSQL transaction and cache
  invalidation.
- The 10,003-record hosted gate passes with mutation p95 84.01 ms, snapshot
  1.334 s, change-page p95 27.38 ms, warm-read p95 46.72 ms, and warm-query p95
  27.5 ms. The mutation budget remains 200 ms.
- Editor, Workouts, Pickle Android, and TaskNotes must consume one immutable
  beta.33 artifact set and roll out with the matching services as one train.
  Do not activate the earlier beta.32 candidate.

## 0.1.0-beta.32

Beta.32 is a coordinated breaking release of the SDK, desktop connector,
control plane, hosted provider, MCP service, and controlled applications. It
does not preserve beta.31 SDK names, package exports, authorization binding, or
operation wire compatibility. It does preserve and migrate supported beta.28+
data, grants whose signed meaning remains exact, audit history, and completed
mutation receipts.

### Durable mutation recovery

- Every mutation uses one durable request identity and a canonical,
  cross-language request fingerprint. Identical retries return the recorded
  result, wait boundedly for a live owner, or take over an expired lease under a
  new fencing generation.
- Local SQLite and hosted PostgreSQL authorities share the same generated
  mutator catalogue and recovery-state contract. Filesystem effects record
  enough prepared/applied evidence to recover safely across Linux, macOS, and
  Windows process interruption.
- A reused request ID with different input is a permanent typed conflict. A
  stale fenced owner cannot commit evidence or a receipt.
- `operation_outcome: unknown` is reserved for the narrow case where durable
  evidence cannot distinguish whether an effect occurred. Applications retain
  the original request ID and call the pending mutation's `recover()` method;
  they must not submit the mutation again with a new ID.
- Unacknowledged completed receipts remain online for 180 days; acknowledged
  receipts become compaction-eligible after 30 days. A privacy-minimized
  request/fingerprint tombstone remains for the 365-day replay horizon after
  compaction. A retry outside the supported horizon fails explicitly rather
  than risking a duplicate effect.

This is not a claim of magical exactly-once distributed execution. It is a
testable identity, fencing, evidence, and recovery guarantee around each
logical mutation.

### SDK and compatibility

- The golden path is `MdbaseConnect -> MdbaseApplicationSession ->
  MdbaseConnection`, created with `connect.application(...)`.
  `createApplicationSession` and obsolete root transport/crypto aliases are
  removed.
- Every public asynchronous operation accepts the same final
  `ConnectRequestOptions` shape with `signal` and `timeoutMs`. Expected boundary
  failures return typed `ConnectOutcome` data; raw JSON parse, fetch, and
  database-wait errors do not cross the public boundary.
- Durable pending mutations are discoverable after restart and recover their
  stored encrypted request directly. Watch startup is bounded separately from
  the explicitly closable subscription lifetime.
- Package release, operation transport, authorization binding, semantic
  capabilities, and durable-mutation support are negotiated as independent
  contracts. Beta.32 uses operation transport v2, authorization binding v3,
  semantic capabilities v1, and durable mutation v1. An incompatible contract
  fails before the affected authority operation with a typed mismatch; a
  package-version difference alone is not an error.

### Data safety and operations

- The local registry now uses numbered, checksummed SQLite migrations, a
  durable ledger, integrity checks, and authenticated permission-restricted
  online backups. Beta.28 fixtures upgrade in place and every injected
  migration interruption resumes idempotently without touching canonical
  Markdown.
- Hosted record, resource, sync, timer, and file mutations use one
  provider-neutral PostgreSQL journal. Legacy beta receipts migrate once and
  legacy runtime paths are removed.
- Database acquisition, statements, locks, transactions, fetches, and public
  request paths have explicit bounds. Invalid responses normalize to typed
  outcomes.
- Privacy-safe release signals cover journal state/age, takeover, replay,
  request-ID conflict, unknown outcome, migration failure, database timeout
  class, invalid boundary response, and pool utilization. They contain no
  collection identifiers, paths, payloads, keys, tokens, or response bodies.

### Upgrade and recovery guidance

- Upgrade the desktop connector, hosted services, SDK applications, and managed
  consumer release train together. Beta.31 peers are valid rollback targets,
  not a reduced-semantics compatibility mode inside beta.32.
- When an application reports `upgrade_required`, update the named authority or
  application component. Authority-backed access pauses until its required
  contracts match. Canonical local Markdown, and any genuinely independent
  application replica, remain usable without making an incompatible authority
  call.
- When an outcome remains unknown, keep the draft or user intent visible,
  reconcile the collection, and recover the exact pending request. Do not use a
  generic retry that creates another mutation identity.
- Rollback restores the previous consumer artifacts and service image digests
  as one train. Restore the verified pre-migration database backup only if the
  previous binary cannot open the additive candidate schema; beta.32 does not
  retain dual legacy readers merely to support mixed-version runtime.

Unsigned macOS and Windows GitHub artifacts remain explicitly labelled preview
builds and require the platform-specific manual trust steps described in the
[release checklist](docs/releasing.md). They are not the canonical signed
installation channels.
