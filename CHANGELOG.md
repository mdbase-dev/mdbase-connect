# Changelog

## Unreleased

- The editor's guided person setup installs `mdbase.contact` 1.3.0, whose
  Person v3 starter neither declares nor requires `type`. People created in
  collections whose `settings.explicit_type_keys` is not `[type]` (such as
  `[mdbase_type]`) no longer fail validation with `schema_required: type`.
  Person v3 carries `upgrade_from` the 1.2.0 Person v2 seed; an installed v2
  seed still stops the guided flow for review in Types. No API changes.

- Application-session startup no longer tears down replacement verification
  when a route or selection refresh cancels an obsolete setup assessment.
  Only that generation's expected cancellation is ignored; genuine exceptions
  and current assessment failures remain visible. No public API or
  authority protocol changes.

- `readMany(paths, options)` now uses revision-bearing document batches when
  `read-many-documents-v1` is advertised, retaining typed path queries otherwise
  with zero extended requests to unsupported authorities. Signature, ordering,
  duplicates, body/frontmatter options and bounded scheduling remain unchanged.
  Type filtering stays authority-owned via query preselection; subsequent reads
  return their own content+revision pair, not a discovery token. Qualified reads
  require existing read approval. Legacy consumers still need revision reads;
  exact Markdown and full record documents remain the point-read API.

- Record-session watch following bounds refresh admission to four sessions and
  coalesces event bursts, so a change gap across 1,000 open records no longer
  leaves most records silently stale. Transient read failures retry with
  backoff; failed refreshes remain visible through the existing `error` and
  `problem` snapshot fields. Reconciliation preserves write ordering and waits
  for exact recovery. No consumer API changes are required; existing error UI
  should handle read failures as well as write failures.

- Client query/view iterators release paused cursors on abort and accept an
  opt-in `maxResults` total cap (`limit` still means page size). Cursor `pageSize`
  controls the initial pinned size; continuations omit `limit`. Migration:
  remove small `firstPageSize` overrides when a larger cursor scan is intended;
  the error-based adaptive-size retry is removed. TaskNotes can drop its paused
  iterator abort workaround. `readMany(paths, options)` adds typed, escaped,
  bounded path batches with input ordering, missing entries and batch failures;
  current query results carry no revisions, so revision reads remain necessary.
  `linksTo(field, path, {multiple?})` builds authority-resolved scalar/list CEL
  predicates. See `docs/sdk-query-helpers.md` for semantics and migrations.

- The client SDK exposes discriminated change events with camel-case record,
  schema, configuration, contract, view and file metadata. Original event IDs,
  payloads and wire events remain available; unknown IDs/payloads and feed gaps
  are explicit variants. `describe()` caches successful results for up to 60
  seconds, shares concurrent loads, and invalidates on structural events and
  accepted schema mutations. `schemaGeneration` tracks local invalidation;
  `describe({ fresh: true })` forces an authority refresh. The editor consumes
  typed events and no longer discards configuration/contract changes. Migration:
  use `kind` and typed fields instead of raw-ID heuristics; normalize custom test
  events and pass `fresh: true` when every description must reach the authority.

- The SDK discovers authority-local implementation features through approved
  descriptions or file listings, sharing in-flight discovery and caching only
  for the current connection/route lifetime. `files.stat({path}|{fileId})`
  returns typed metadata/null outcomes with a capability-gated legacy listing
  fallback. Metadata query output is opt-in and revision-required; unsupported
  authorities receive no extended requests. Existing query/list callers are
  unchanged; metadata consumers must retain their ordinary-query branch until
  minimum-authority, consumer-adoption and rollback gates close. No authority
  capability is advertised by this SDK change.

- Native v0.3 authorities transport exact-source query revisions, bounded ordered
  document batches through `read`, and opt-in `output: "metadata"` queries with
  no full frontmatter/body envelope. Local and hosted adapters share mdbase-rs's
  evaluators/renderers; contract output variants await B5. Consumers must use B1
  positive capability discovery and retain old-authority behavior, never infer
  support from errors. Hosted projection format 9 requires a derived-generation
  rebuild; query plan 13 invalidates predecessor cursors. Payloads/database schema
  are not forward-only, but rollback requires predecessor projection rebuilding
  and cursor restart. See `docs/architecture/sdk-wave-b-authority.md` for limits,
  migration, rollback and the 30k-row transfer benchmark.

- Directory mirrors (`@mdbase-dev/connect-sync`) recover from routine local
  interference without a person: a scoped blocking issue (an obstruction,
  divergent or unreadable file) fences only its own path and connected path
  transitions, so independent files still sync while the checkpoint waits.
  Writes pass the inspected text to the adapter, which can reject a competing
  edit at its atomic write boundary; the stale batch is then released so the
  next review reports a conflict instead of replaying the old plan forever.
  Adapters that report physical path kinds turn a folder occupying a
  destination into an actionable blocking issue rather than an impossible
  write. Inspection no longer downloads attachment bytes; they are fetched,
  verified and reported through the caller's cancellable transport only while
  applying, and an abort mid-transfer is recorded as a pause that the next sync
  resumes. `DirectoryMirror.review()` returns the plan and its status from one
  inspection; `status()` now uses it.

- Re-registering or pairing a connector again clears obsolete cached remote
  grants and its previous connector identity, instead of leaving the relay
  permanently disconnected. Local collections, access controls, transfer fences,
  device identity and recovery evidence are preserved. A mismatched policy now
  reports an actionable registration error instead of retrying as a transport
  interruption; a live account change requires a daemon restart.
- Hosted writes enforce unique values and required links using canonical engine
  validation. Valid no-op updates return the stored record and a replayable
  receipt instead of failing. The engine update rebuilds hosted projections and
  provider migration 0045 adds the targeted uniqueness-key index.
- Concurrent upload finalizations use separate destination objects, so a delayed
  copy cannot overwrite content another attempt verified and published. Object
  cleanup is durably queued with publication.
- Hosted imports preserve their exact local source authority during inventory
  refreshes and resume durable transfers safely. Server migration 0036 narrowly
  repairs historical source demotions without clearing local transfer fences.

- Approving an application no longer re-reads the whole local collection.
  Activation and account-driven setup finished with a full runtime
  synchronization that parses every record; setup is a runtime mutation, so
  it is now finalized like any other, and an application that declares no
  setup finalizes nothing. On a synthetic 30,000-note TaskNotes collection
  each approval saves about 0.9 s: a first approval takes 3.4 s instead of
  4.4 s, and a repeat approval 0.15 s instead of 1 s. The agent logs each
  activation's phase timings (`application authorization activated`) and
  each requested runtime reconciliation's queue, synchronization and
  finalization time (`runtime reconciliation completed`).
- Permission reviews survive background refreshes; changed access requires a new
  review. Pairing retries the same request after network interruptions and can
  reopen the browser without starting over. Successful account changes are no
  longer treated as failed when the following refresh fails.
- The editor offers browser-local recovery of unsaved note edits after a restart,
  with explicit restore/discard choices and seven-day retention. Full-text content
  loads on demand for search and backlinks instead of at collection startup.
- Desktop collection creation uses the shared keyboard-accessible dialog and
  keeps errors inside it. Collection-row failures stay beside their controls;
  folder-opening failures are no longer ignored. Synced-folder conflicts now
  offer exact Markdown comparisons or binary metadata before choosing a winner.
- The desktop app's connection status no longer freezes behind a slow
  refresh: each source refreshes on its own, so a hosted-collection snapshot
  that takes up to 30 s cannot hold "Connecting securely…" on screen. Pairing
  requests to the server time out after 10 s with an error instead of waiting
  indefinitely.
- Hosted Obsidian Base views work again in collections whose tasks link to
  other notes without an extension, after TaskNotes' setup added `base` as a
  record extension. mdbase-rs `7bd18f1` (0.4.0-rc.6) records the extension
  lookup that actually matched such a link, so its resolution evidence
  validates; before this, every Base view reaching a linked record failed
  with "Obsidian Base evaluation requires a current, integrity-bound
  projection". The engine version change rebuilds hosted projections.
- Approving an application for a large local collection no longer times out.
  Collection setup plans from configuration, locks and definitions alone and
  never copies or validates every record, so assessing it takes milliseconds
  at any collection size. Approval sets up the application's complete
  declaration (every type pack the approval screen lists), so the application
  no longer asks for a second setup review on first open, and approving again
  writes nothing when setup is already current. On a synthetic 30,000-note
  TaskNotes collection, first approval fell from 17s to 3.5s, approving again
  from 22s to under 0.1s, and each application start's setup check from 4.8s
  to 0.03s; the 21s second review is gone. A setup review now depends only on
  the setup inputs, so editing notes while it is open no longer makes it
  stale. The
  unused `baseline_diagnostic_count`, `final_diagnostic_count`,
  `resolved_diagnostic_count`, `introduced_diagnostic_count` and
  `baseline_diagnostic_digest` assessment fields (and their SDK
  `CollectionSetupAssessment` counterparts) are removed.
- Hosted collections store Obsidian Bases as records once collection setup
  adds `base` to `record_extensions`, as local collections do. Setup converts
  each existing Base view resource into a typed record with its exact
  document, and `list_views` and `execute_view` include Base and saved-view
  records whose types implement `obsidian.base` or `mdbase.view`. Before this,
  a hosted Base could not be read or edited with the record operations after
  that setup, and a Base created as a record was not listed.
- Applications may require and add `md` or `base` to a collection's
  `settings.record_extensions` during collection setup (mdbase-rs `1c6290c`),
  so an application can store Obsidian Bases as records. It is the one setup
  target outside an `x-*` namespace, and it is shown in setup review like any
  other change. Connectors advertise `yaml-document-records-v1`, and the server
  asks for a connector update before activating an application that adds
  `base` records on a connector that would read them as Markdown.
- Mirrors materialize Obsidian Bases stored as YAML document records
  (`.base`) alongside Markdown notes, and read each record in the format its
  extension fixes. The mirror's record extensions remain fixed product policy
  that collection configuration cannot extend.
- Saved views are records whose type implements the `mdbase.view` contract
  (mdbase-rs `0d96ad4`, spec `1e147ca`), not records named or typed `view`.
  Applications that save views provision the `mdbase.view` pack during
  collection setup and write views with ordinary record permissions.
  `type: view` records with no implementing type are no longer listed or run
  until the pack is installed. Single-record writes also work again after
  installing a pack whose schemas live outside `_schemas/`.
- Hosted canonical views page while the projection is being rebuilt after a
  definition change, instead of failing with a provider error (provider
  migration 44).
- The Editor's interface text is at least 11px, the outline button sits with
  the note bar's other controls, and pane controls are distinct.
- The Editor's "Your person record" panel explains when the Editor was not
  approved to read your account identity (grants approved before portable
  people record no People permissions) and offers to review the Editor's
  access for the collection, instead of a retry that could not succeed.
- When collection setup needs type-pack review, the error names the conflict
  (for example "_types/task.md: Seed upgrade conflicts with customized
  setting …") instead of "the type pack requires review".
- Collections use mdbase-rs `88d4a21`: a type pack defers to another pack that
  manages identical bytes for the same file, so mdbase Reader and mdbase
  writer can both be set up on one collection.
- Added portable people. An application can declare
  `people: { version: 1, required?: [...], optional?: [...] }` in its manifest
  to ask for `identity` (the signed-in account's name and a stable
  `issuer`/`subject` pair) and `members` (the collection's members). The
  approval screen lists these separately, `members` starts unticked, and the
  grant records exactly what was approved. Subjects come from a new per-account
  `public_subject` (`acct_…`), never an internal id, and the issuer is the
  deployment's configured `MDBASE_CONNECT_IDENTITY_ISSUER`, which Connect now
  requires outside loopback development. Existing grants carry no people
  permissions; applications that declare them are reapproved.
- The SDK adds `connection.people.current()`, `members()` and `directory()`.
  `directory()` reads every record implementing `mdbase.person` 2.0.0 and
  resolves the current account to `linked`, `unlinked`, `ambiguous` or
  `invalid` by exact issuer and subject; other records refer to a person by
  link. `QueryRecord.values` is now declared.
- The Editor can link your account to a person record from Settings, choosing
  an existing contact or creating a note, and sets up person records in a
  collection only after you review the exact definition files.
- Collections use mdbase-rs 0.4.0-rc.5, which implements mdbase spec
  v0.3.0-rc.4. Expressions are standard CEL: `note.` and `present.` are gone
  (use `record.` and `has()`), selecting a field of null is an error (use a
  null check or optional selection such as `a.?b.orValue(null)`), dates are
  `YYYY-MM-DD` strings, and `lower()`/`upper()` fold case. Links read from
  `this` or from `asFile()` resolve relative to their own record, and
  `file.links` holds alias-free link values. Hosted updates send `patch`; the
  `fields` alias is rejected. Stored semantic projections move to format 7.
  New collections write `settings.validation` (template revision 3).
- Hosted collections stay available when the provider moves to a new semantic
  engine. Queries on a collection still indexed by the previous engine run on
  exact fallback, and writes unbind that index instead of failing with
  `projection_engine_mismatch`, so a previous provider still serving during a
  rolling deploy treats the collection as unindexed. Background recovery leaves
  these collections for the new `mdbase-hosted-projection-indexer upgrade`
  command, which rebuilds each one once the previous provider has stopped and
  binds the new index atomically. Recovery also abandons an unfinished rebuild
  left by a provider on another engine instead of stopping on it.
- Added record sessions for editing a record while people type:
  `connection.records.open(path)` returns a session shared by every view of
  that record. It autosaves after a pause, never runs two writes for one
  record, sends only changed frontmatter keys and the body, and reports a
  conflict only when another change touched something edited locally. A save
  whose response was lost is recovered exactly, including after a reload, and
  `connection.records.follow(watch)` keeps open records current through
  changes, renames, deletions and change gaps. See
  [Record sessions](docs/record-session.md).
- `@mdbase-dev/connect-testing` adds `createRecordTestAuthority()`, an
  in-memory authority for testing record editing: revision checks, a change
  watch, edits, renames and deletions from other clients, lost responses and
  refused writes.
- Local collections now report a stale `ifRevision` as
  `concurrent_modification`, a missing record as `file_not_found` and an unsafe
  path as `invalid_path`, as hosted collections already did. These were
  previously `operation_invalid`; code matching on that for these conditions
  must switch to the specific codes.
- Encrypted requests and responses are encoded and decoded in chunks: a 1 MB
  update takes 140 ms instead of 188 ms and a 1 MB read 32 ms instead of 74 ms
  in the browser write profile (`pnpm profile:writes`).
- Local saves no longer rescan the whole collection after each atomic write,
  so a small browser update takes about 30 ms instead of 50 ms at 1,000
  records, and runtime saves at 5,000 records take 44 ms instead of 158 ms.
- Fixed local creates and updates restarting generated `sequence` fields from
  their start value and duplicating values already in the collection.
- `usage report` now reports hosted users from the hosted provider (previously
  always 0), a consent breakdown by authorization flow and by distinct
  application installation, and weekly signup-cohort retention.
- Added the operator `usage report` command: activation funnel, beta
  conversion, pairing and consent outcomes, collection mix, transport use, and
  per-application usage as aggregate counts from existing control-plane rows.
  See [Usage report](docs/usage-report.md).
- Local collections now record their registration time (migration
  `0033_collection_created_at`); existing rows remain unknown.
- The Connect server deletes protocol usage counts, expired tokens, and
  unfinished pairing and authorization requests 395 days after they stop
  mattering to authorization.

## 0.1.0-beta.107

- Fixed Windows startup failing with `Unexpected token 'S'` when Task Scheduler
  success messages were mixed into the connector's JSON response. Thanks to
  @shonatiger for reporting this in
  [TaskNotes #2350](https://github.com/callumalpass/tasknotes/issues/2350).
- PostgreSQL connection failures are contained at both idle-pool and checked-out
  client boundaries, preventing an idle-transaction timeout during hosted
  provider I/O from terminating the Connect process.
- Failed checked-out clients are discarded even when a fatal query response
  races the socket-close event; failed transactions remain rolled back and are
  never retried or reported as successful.
- Real PostgreSQL coverage verifies process survival, rollback, CORS-preserving
  HTTP failure, idle-client termination, active-query termination, and recovery.

## 0.1.0-beta.105

- Durable notification timers now use the stable `notification-timer` source
  identity instead of the surrounding Connect release version, so compatible
  upgrades no longer strand scheduled notifications.
- Hosted migration 43 and the matching local migration rewrite only known
  beta.27–beta.104 timer identities with the exact compatible contract. Unknown
  identities remain rejected, active hosted claims block migration, and expired
  claims are fenced before recovery.
- Notification recovery no longer reports success while overdue timers remain
  leased, and privacy-bounded diagnostics expose only allowlisted runtime error
  stages and categories.
- Hosted provider schema 43 is forward-only: beta.104 must not be restored over
  a migrated database. Staging and production require the registered 42→43
  transition and forward-recovery qualification.

## 0.1.0-beta.104

- Local daemon mutations now retain a durable owner and settle completion claims,
  preventing successful CLI batches from exhausting runtime transaction capacity.
- Interrupted local preparations and completed writes reconcile before the next
  mutation; application and relay replay boundaries remain unchanged.
- `mdbase connect collection recover-writes <collection-id>` previews retained
  writes and supports explicitly selected, independently verified local recovery.
  It preserves application-owned, unsettled and revision-mismatched transactions.
- Local authority state advances to schema 5. Older daemons reject upgraded state;
  restarting alone does not recover historical orphaned claims. See
  [local write recovery](docs/local-write-recovery.md).

## 0.1.0-beta.94

Beta.94 replaces type-scoped application grants with explicit collection-level
authorization and strengthens release compatibility gates.

- Applications request and receive one canonical full-collection scope while
  operation, file, origin, proof-of-possession, and collection boundaries remain
  independently enforced.
- Existing scoped grants, tokens, hosted replicas, and notification authority
  retire fail closed and surface an actionable reauthorization outcome rather
  than being silently widened or reported as corrupt state.
- Local and hosted execution reject legacy scope at every admission boundary;
  exact terminal hosted mutation replay remains available only to still-valid
  retired credentials and cannot authorize changed or new work.
- Authorization approval compensates retained provider policy changes if the
  control-plane transaction fails, revoking the replica when restoration cannot
  be proved.
- Immediate-predecessor persisted-state CI attempts a candidate write before
  projection normalization, runtime diagnostics compare persisted projections
  with the running engine, and release tooling blocks undeclared projection
  format or semantic-engine transitions.
- A live projection-cutover lease admits semantic queries while canonical,
  synchronization, file, import, and provider-control writes remain fenced.
- Exact Editor qualification preserves immediate revalidation on immutable
  Pages assets while separately verifying the canonical domain's bounded,
  managed four-hour policy for edge-cache-eligible asset classes.

## 0.1.0-beta.93

Beta.93 consolidates collection semantics behind typed, capability-bound
runtime APIs and completes cross-platform authority safety.

- Local and hosted reads, queries, mutations, batches, and runtime receipts now
  share canonical typed outcomes while preserving exact v0.3 wire behavior and
  durable replay.
- Collection snapshots are fallible and deterministic; merged-spec resolution
  uses one Unicode-aware, target-filtered ranking contract with bounded
  selection evidence.
- Every post-open filesystem operation, watcher rescan, cache decision, and
  publication remains bound to the acquired collection authority instead of
  reacquiring an ambient display path.
- Capture, cancellation, journal recovery, and compatibility seams are bounded,
  checked, authenticated, and covered by enforceable retirement inventories.
- Unix and Windows publication is capability-relative and atomic. Windows uses
  destination-replacing handle-relative rename, delete-sharing readers, and
  bounded sharing-denial retries without a remove-then-rename fallback.
- Hosted mutation receipts and exact journal replay report the authoritative
  persisted database mtime rather than temporary staging metadata.

## 0.1.0-beta.92

Beta.92 restores relay compatibility with signed beta.90 connectors while
preserving the stronger policy-freshness lease as an optional beta capability.

- Relay policy negotiation now selects explicit `lease_v1` or frozen
  `legacy_ack_v0` behavior; beta.90 receives its original policy wire shape and
  acknowledgement revision without claiming bounded offline revocation.
- Lease negotiation and acknowledged adoption are durable and monotonic, so a
  concurrent, failed, or incomplete attach cannot reopen legacy admission after
  a connector has crossed either boundary.
- Initial and changed-policy acknowledgements fence routing and publication;
  stale mutation responses surface an unknown outcome instead of publishing
  through superseded authority.
- Advisory replacement broadcasts now use a bounded broker flush, so a stalled
  broker acknowledgement cannot prevent the initial policy from reaching an
  otherwise authenticated connector session.
- Connector-side lease adoption remains sticky, partial lease metadata fails
  closed, and websocket shutdown aborts the policy coordinator before it can
  restore a disconnected session to `Connected`.
- Account surfaces truthfully recommend updates for legacy acknowledgements and
  retain beta.91 as the lease capability floor while the baseline connector
  floor remains independent.
- `policy-freshness-lease-v1` stays optional for every beta. Stable `v0.1.0` is
  only the earliest possible enforcement boundary and remains subject to the
  documented production-observation and rollback gates.

## 0.1.0-beta.91

Beta.91 hardens collection ownership, filesystem convergence, and authorization
revocation across the Editor, local connector, hosted provider, and mirrors.

- Editor collection transitions freeze and drain owned work before changing
  authority, fence stale publication, isolate transclusions, and keep detached
  type-definition saves generation-safe.
- Watcher and mirror paths preserve typed invalid-record outcomes, capability-
  bound filesystem reads, exact cache acknowledgement, bounded retry state, and
  feed silence for invalid private observations.
- Hosted authority imports, mutation recovery, account snapshots, selected-folder
  scopes, and exact timer reconciliation now retain their execution-time
  authority and fail closed under contention or stale completion.
- Connector policy leases use exact-session acknowledgements, bounded renewal,
  cross-instance coalescing, and transport-bound publication fences so revoked
  work cannot publish through a successor policy.
- Release tooling can bind an exact signed candidate, client, and Editor revision
  to guarded LAB-only deployment and rollback evidence without permitting a
  staging or production target.

## 0.1.0-beta.90

Beta.90 makes account deletion transactional, isolates stale hosted grants, and
extends the production canary through application registration.

- Account deletion revokes local capabilities and commits the user teardown in
  one transaction before durable, retryable provider cleanup begins.
- Cross-account replicas, failed local transactions, transferred authorities,
  provider outages, and duplicate cleanup delivery are handled explicitly.
- Confirmed missing provider collections are quarantined locally; their grants,
  tokens, replicas, and pairing requests fail closed without conflating
  ownership conflicts or transient provider failures.
- One confirmed-missing grant no longer blocks another account from registering
  the same application, while ownership conflicts remain visible failures.
- The hosted-read canary now registers the exact portable CLI application before
  authenticated describe, marker read, and digest verification.
- `MDBASE_CONNECT_ACCOUNT_DELETION=disabled` retains a fail-closed operational
  hold for future incident response.

## 0.1.0-beta.89

Beta.89 temporarily pauses account deletion while the hosted deletion workflow
is corrected.

- Account deletion fails closed after same-origin and session authentication,
  without consuming reauthentication tokens or changing account state.
- The account surface explains that deletion is temporarily unavailable.
- Hosted provider data and credentials are never mutated by a blocked request.

## 0.1.0-beta.88

Beta.88 improves the editor's loading continuity, navigation, and feedback.

- Loading skeletons align with the editor surface on desktop and mobile.
- Note lists gain grouped headers and accessible arrow-key navigation.
- The editor adds word counts, document outlines, action-palette commands,
  unified toasts, and smoother preview transitions.

## 0.1.0-beta.88

Beta.87 makes local multi-collection discovery fast and resilient and corrects
editor authorization redirects.

- Local collection listing is metadata-only, while authorization descriptions
  use read-only resource snapshots without opening record runtimes.
- Catalog discovery isolates malformed collection resources, reuses one catalog
  per authorization offer, and preserves fresh authorization checks at the
  connector boundary.
- Notification recovery keeps idle and future work cold, opens runtimes only for
  actionable persisted work, and rechecks collection authority before dispatch.
- Relay inventory synchronization is single-flight, and high-frequency runtime
  finalization is bounded to resident enabled collections.
- Editor authorization now preserves valid same-origin return targets and uses
  the correct production editor fallback.

## Unreleased

## 0.1.0-beta.86

Beta.86 opens verified public password signup and makes non-production Connect
environments explicit and isolated.

- Public signup verifies email ownership before accepting a password, preserves
  same-origin authorization return targets, rate-limits requests and token
  redemption, and avoids revealing whether an account already exists.
- New public accounts receive the permanent open-beta entitlement, including
  1 GiB hosted storage and three hosted collections, plus a starter collection,
  legal agreement records, and a signed-in browser session atomically.
- Account creation claims canonical verified emails across password, invitation,
  and external-provider flows so concurrent signups cannot create duplicate
  owners without authenticated account linking.
- Invitation signup retains its original ten-collection beta allowance while
  registration is open, and the retired beta-access request endpoint no longer
  stores submissions.
- Server health identifies the deployment environment, while editor and desktop
  tooling reject mismatched lab, staging, and production endpoint combinations.

## 0.1.0-beta.85

Beta.85 makes SDK startup explicit and turns application declaration drift into
a safe, recoverable reauthorization flow.

- **Breaking:** `MdbaseApplicationSession` replaces `opening` with explicit
  `not_started`, `starting`, `start_failed`, and terminal `destroyed` lifecycle
  snapshots. `start_failed` carries the original typed problem and `start()`
  retries it.
- **Breaking:** lifecycle-dependent async methods now resolve typed lifecycle,
  timeout, and cancellation outcomes while sharing an in-progress startup
  budget. `select`, `clearSelection`, and `forget` return lifecycle-aware
  `ConnectOutcome` values. Provisional startup returns `session_starting`, and
  failed startup methods reuse the exact `start_failed.problem` object.
- Saved grants bound to a previous registered application identity now surface
  `application_declaration_mismatch` as `authorization_required` before setup
  checks. Migration requires an explicit `authorize("selected")`; Connect
  preserves pending mutation recovery and does not replay it automatically.
- Grant-key rotation preserves in-flight and durable mutation recovery across
  browser contexts, then removes retired key material only when it is safe.
- The editor gates collection actions on successful startup and provides an
  explicit retry path for recoverable startup failures.

## 0.1.0-beta.84

Beta.84 tightens hosted operation correctness and enables Obsidian Base views
for newly created hosted collections.

- Fresh hosted collections provision `views/**/*.base` alongside canonical
  Markdown sources, with aligned Rust and TypeScript template semantics.
- Hosted entitlement reconciliation is resumable, idempotent, and protected
  from overlapping operator batches.
- Background sync can acknowledge reviewed plans it already completed while
  retaining pending recovery and stale-plan protections.
- Hosted operations reject unknown or mistyped inputs, preserve authoritative
  persisted mutation outcomes, and distinguish safe rejection from uncertain
  non-JSON responses.
- CLI and server authorization now align owner-only batch and timer operations
  with generated protocol metadata.
- Control-plane availability reports transport reachability without masking
  malformed protocol responses or structured authorization failures.
- The hosted provider uses mdbase-rs revision
  `4f861ba14b685e952ed7e7be869e3980a9eda613` so canonical Markdown views are
  classified and committed as resources through the single-writer runtime.

## 0.1.0-beta.83

Beta.83 makes Connect onboarding and collection management simpler and more
consistent across browser applications, the desktop client, and the portal.

- Account-first onboarding now carries the user's intent through pairing,
  explains existing-folder setup, and ends with durable collection receipts.
- Applications can opt into a focused popup authorization flow with redirect
  fallback, isolated-window recovery, and in-place completion in the original
  application session.
- Reauthorization clearly separates existing access from newly requested
  actions, while grant editing remains limited to narrowing or revoking access.
- Authority transfer uses one consequential approval with readiness, progress,
  application and replica impact, completion, and retired-authority history.
- Desktop, Connect management, and transactional approval terminology now
  distinguishes durable configuration from individual data operations.
- Windows release qualification now compares canonical repository content so
  Git's CRLF checkout conversion cannot block an exact qualified commit.

## 0.1.0-beta.82

Beta.82 keeps hosted saved views usable when an ordinary Markdown record cannot
be parsed completely.

- Hosted Obsidian Base evaluation now omits semantically incomplete candidate
  and related records after first verifying their projection integrity. One
  malformed frontmatter document therefore no longer aborts every readable row
  in the view.
- The successful view response includes a `hosted_base_record_skipped` warning
  so applications can explain the omission without exposing record paths from
  contract-scoped collections. Stale or integrity-invalid projections,
  incomplete required query context, and structural resource failures remain
  fail-closed.

## 0.1.0-beta.81

Beta.81 permits applications to work with collections containing records that
do not yet satisfy their schemas.

- Application setup and direct type-pack installation no longer reject an
  otherwise structurally valid collection because installing the types exposes
  record-schema violations. Setup assessments continue to report baseline,
  final, introduced, and resolved diagnostic counts.
- Hosted saved views can evaluate the parsed frontmatter of schema-invalid
  records without failing the whole view. The records retain their validation
  diagnostics, while malformed frontmatter, malformed relationships, and
  body-dependent projection gaps remain fail-closed.

## 0.1.0-beta.80

Beta.80 fixes type-pack updates that rename a resource's source while retaining
the same installed target.

- Type-pack retirement planning now treats an installed target as owned by the
  desired pack even when its source path changed. Previously the planner could
  adopt the resource from its new source and then retire the same target under
  its old source receipt. For packs containing an exact data contract, that
  removed the contract after adopting it and left implementing types invalid.
- The fix preserves the desired target and retires only resources whose targets
  are genuinely absent from the desired pack. A regression test covers renamed
  schema, contract, and seed sources, including collection reopen validation.

## 0.1.0-beta.79

Beta.79 fixes a durable write race in the engine and a credential expiry that
never decoded.

- The runtime transaction commit path now rejects a commit against a path
  another commit owns but has not settled. Settlement runs after the commit lock
  is released, so a committed-but-unsettled transaction was invisible to the
  precondition check and two writers could both take commit points against one
  baseline. Whichever settled second found a revision matching neither its
  before nor its intended state, stranded its journal as needing manual
  recovery, and that journal then failed every later collection open — so an
  ordinary lost write race could leave a collection unopenable. The loser is now
  rejected before taking a commit point, reporting a concurrent modification
  conflict, which is what it is.
- `storage.credential_expires_at` in the hosted provider diagnostics surface
  reported no expiry for every temporary credential. The session token is
  standard base64 of `jwt/<header>.<claims>.<signature>` rather than a bare JWT,
  so its claims were never read and an expiring credential was indistinguishable
  from a permanent one. That is the field the surface exists to provide, and it
  failed in the direction of false reassurance.

Note for operators: a modest increase in concurrent modification conflicts is
expected and correct. Races that previously succeeded and then stranded now
surface as conflicts instead. A sustained rate against a small set of paths is
the signal worth investigating, not the aggregate change.

## 0.1.0-beta.78

Beta.78 adds a diagnostics surface to the hosted provider.

- `/internal/v1/diagnostics` reports projection readiness by cause, durable
  projection checkpoints, drain state, the applied migration ledger, storage
  configuration including credential expiry, and recent resource changes. Like
  the existing query-activity route it is internally authenticated and bypasses
  admission, so it answers while the provider is fenced.
- Each section is separately bounded and separately fallible: a slow database
  yields one unavailable section rather than an unanswerable request. The
  payload is versioned, and every section is aggregate-and-identifier only, so
  no record content, frontmatter, body prose or key material is exposed.
- Two reviewed read-only SQL files ship in the provider image for row-level
  forensic detail where the aggregate surface is not enough.

## 0.1.0-beta.77

Beta.77 fixes a hosted-provider outage in which saving an Obsidian Base source
took the whole provider offline.

- Resource mutations advance the collection resource revision, but the
  projection catalog binding was invalidated only for type mutations. A view
  mutation left the active generation pinned to a superseded revision with no
  rebuild scheduled, stranding the collection permanently stale. A Base source
  is a query definition and no projected fact derives from it, so the generation
  is now carried to the new revision; type mutations still invalidate.
- Readiness no longer fails when a collection's projection is absent or
  rebuilding. Such a collection is served from bounded canonical exact fallback
  by design, so `/ready` now reports `projections.degraded_collections` instead
  of returning 503 and withdrawing a provider that is serving correctly.
- The Pickle SDK gains a `pickle_attachment` type and
  `PickleCollection.readAttachment`, advancing its type pack to 1.1.0.

## 0.1.0-beta.76

Beta.76 separates derived-state integrity verification from semantic exact
fallback. A fully verified generation may contain records that mdbase-rs marks
semantic-incomplete; query initialization detects those rows independently and
keeps them on bounded canonical exact evaluation. This preserves both the final
cutover integrity gate and complete query results.

## 0.1.0-beta.75

Beta.75 allows a projection generation to activate when a canonically parsed
record intentionally requires exact fallback, while continuing to require
complete relationship resolution and valid projection digests. This prevents
the production cutover indexer from repeatedly rebuilding collections that
contain malformed Markdown or body-dependent computed fields. Query execution
still treats those rows as projection-incomplete and uses bounded exact fallback;
authorization classification remains fail-closed.

## 0.1.0-beta.74

Beta.74 replaces the unreleased Candidate B migration history with the final
single-runtime upgrade from the production beta.69 schema. Encrypted exact
Markdown remains authoritative; PostgreSQL stores only the accepted readable,
rebuildable semantic projection and bounded relationship graph.

- Hosted migrations 0035 and 0036 now create the complete final projection,
  cursor, receipt, integrity, admission, and indexing contracts directly from
  beta.69 migration 0034. Transitional execution modes, cursor proofs, digest
  shapes, receipt encodings, and staging-only upgrade gates are absent.
- Every active collection requires a current projection binding. New
  collections and imported authorities remain hidden while the resumable,
  fenced indexer builds and verifies their first generation; existing exact
  authorities retain bounded canonical fallback during cutover recovery.
- Ordinary query, validation, saved-view, Base, and mutation paths no longer
  materialize a collection-wide WorkingSet. Closed SQL plans provide
  snapshot-pinned keyset pages, bounded residual work, typed budget outcomes,
  and canonical `file.inFolder(...)` semantics without decrypting body prose.
- The hosted-provider image includes audited `plan`, `apply`, `status`, and
  `verify` commands for an all-collection maintenance-window backfill. Exact
  beta.69 rollback and forward-rebuild procedures preserve canonical records,
  versions, resources, changes, journals, receipts, files, and outbox state.

## 0.1.0-beta.73

Beta.73 makes Candidate B activation safe for isolated staged rollout while
leaving production and all existing collections on their prior execution model.

- New hosted collections can opt into Candidate B only through a versioned,
  capability-checked protocol. A durable pending intent leaves legacy routing
  unchanged until a fully resolved generation is atomically bound to the exact
  authority head and resource revision.
- Projection work remains bounded to one fenced batch per provider call. Large
  authority imports return an explicit resumable `202 activating` outcome after
  each control-plane work allowance instead of exposing a partial collection or
  turning expected continuation into a terminal failure.
- Restart recovery resumes pending generations, exact lost responses reconcile
  only the named generation, and terminal semantic or ciphertext failures are
  quarantined against the same authority/catalog/engine binding.
- Concurrent hosted mutations use deterministic collection-before-replica lock
  ordering, closing the staging deadlock found by the live mutation mission.
  Activation status is snapshot-consistent and reports only bounded operational
  metadata; exact Markdown and body prose remain application-encrypted.

## 0.1.0-beta.72

Beta.72 completes the Candidate B hosted execution architecture behind its
explicit per-collection rollout gate. Exact Markdown remains application-
encrypted and authoritative; PostgreSQL stores a rebuildable, provider-readable
semantic projection and bounded relationship graph generated by `mdbase-rs`.

- Hosted queries now use closed versioned plans, deterministic snapshot-pinned
  keyset pages, bounded ordering/grouping, typed scan/byte/operator/time budgets,
  and prompt database/permit/plaintext cleanup on cancellation without a silent
  collection-wide WorkingSet fallback.
- Exact reads and all point mutations remain revision-CAS protected. Durable
  receipts, transactional projection/relationship updates, stale-projection
  canonical fallback, rebuild leases/fencing/checkpoints, and fail-closed
  authorization recovery cover ambiguous outcomes and restarts.
- Structurally significant body facts—including wikilinks, Markdown links,
  embeds, tags, aliases, anchors, relative targets, and ambiguity evidence—are
  projected without exposing body prose. Narrow identity, cursor, and graph
  indexes are retained; no general projection GIN is added.
- Additive hosted migrations, guarded projection and receipt invariants,
  rollback preflights, observability, deterministic 10k/100k/high-cardinality
  evidence, and isolated-consumer rollout procedures prepare the architecture
  for staged activation. Existing collections remain on their prior execution
  model until explicitly migrated.

## 0.1.0-beta.71

Beta.71 begins the bounded hosted execution rollout and adds direct hosted CLI
access without weakening the encrypted authority boundary.

- The unified CLI can authorize a direct, per-collection hosted connection and
  execute portable data commands against the hosted authority without a local
  filesystem mirror. Hosted requests use short-lived provider capabilities,
  grant-bound P-256 proofs, automatic credential refresh, and the same explicit
  revocation model as other applications. Account login alone still cannot read
  collection contents.
- Hosted point reads now fetch and decrypt exactly one record by stable identity
  or keyed path token, compile canonical resource semantics through `mdbase-rs`,
  and avoid the legacy collection-wide decrypted working set.
- A published execution-budget manifest, privacy-safe memory and scan metrics,
  deterministic large fixtures, and temporary working-set admission limits make
  the remaining compatibility path explicit and bounded during migration.

## 0.1.0-beta.70

Beta.70 lets browser extensions complete the device-code authorization flow
without weakening the exact-origin capability boundary.

- Device authorization records the initiating Chrome or Firefox extension
  origin and binds local and hosted grants to that exact origin. Native clients
  retain the existing opaque `null`-origin behavior.
- Existing extension grants can be reauthorized once to receive the corrected
  origin-bound capability.
- Dependency resolutions move Nano ID to 3.3.18 and replace the vulnerable
  `extract-zip` release with Electron's maintained API-compatible fork.

## 0.1.0-beta.69

Beta.69 makes retained writable mirrors durable across adoption and remote
renames, and finishes the current editor query and PDF hardening.

- An already-identical writable folder now seeds records, collection resources,
  and binary descriptors into its first durable checkpoint. A retained mirror
  no longer attempts to re-upload the authority snapshot it just adopted.
- Applying a remote record rename updates both the mirror entry and its retained
  writable record payload, so the next restart or inspection remains valid.
- Contract-scoped queries support generation-pinned cursor pagination, and the
  editor serves its PDFium runtime and viewer dependencies from its own build.

## 0.1.0-beta.68

Beta.68 keeps the desktop control plane responsive when the operating-system
credential store is temporarily unavailable.

- Desktop refreshes are single-flight, so timer and user-triggered refreshes
  share one bounded request instead of multiplying concurrent control work.
- A locked or unavailable credential store is represented as a typed offline
  hosted snapshot. Repeated hosted polls are served locally for a 30-second
  retry window, while unrelated failures remain visible.

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
