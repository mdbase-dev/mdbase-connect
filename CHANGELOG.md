# Changelog

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
