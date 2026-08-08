# Changelog

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
