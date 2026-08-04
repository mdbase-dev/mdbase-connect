# Beta hardening observability contract

The beta.32 release emits a small privacy-safe signal set for release holds,
recovery drills, and rollback decisions. Signals are structured log fields so
managed deployments can aggregate them without introducing a second durable
authority or exporting collection data.

## Signal catalogue

| `metric` | Fields | Release interpretation |
| --- | --- | --- |
| `mutation_journal_snapshot` | journal state counts, oldest unfinished age, tombstone count, lease counts, database pool size/idle, registry schema version where applicable | Hold when unfinished age grows across samples, stale leases do not clear, or pool idle remains exhausted. |
| `mutation_event` | `mutation_event`, canonical operation kind where available, terminal/recovery state | Count `lease_takeover`, `duplicate_replay`, `request_id_conflict`, and `outcome_unknown` separately. A replay is expected in response-loss drills; an unexplained conflict or unknown outcome blocks promotion. |
| `registry_open_failure` | typed error code | Separates migration/schema/integrity/busy failures without exporting the registry path. |
| `mutation_journal_snapshot_failure` | typed provider error code | Treat as loss of recovery visibility and hold the canary. |
| `boundary_response_failure` | typed response class and, for provider boundaries, HTTP status | Counts invalid relay/provider response classes without recording response bodies. |
| `database_timeout` | bounded timeout class | Separates pool acquisition, statement, and lock exhaustion; any canary-window spike requires explanation. |
| `migration_failure` | no dimensions | The hosted provider could not establish its numbered migration ledger and must not become ready. |

PostgreSQL timeout events already use `database_timeout_class` in the control
plane and `timeout_class` in the hosted provider, with `pool`, `statement`, or
`lock` as the only values. Hosted migration failures and local registry-open
failures are structured separately, so deployment monitoring can distinguish
schema failure from saturation.

## Privacy boundary

Metric events must contain only the fields listed above. They never include a
collection or account identifier, request ID, filesystem path, record content,
frontmatter, query, receipt, key, token, database URL, response body, or error
message. Ordinary request tracing has its own operational retention boundary
and is not a beta-hardening metric.

## Canary holds

Capture a baseline immediately after staging activation, then observe after
Workouts, Editor, Pickle, and TaskNotes in that order. Hold or roll back for an
unexplained unknown outcome, a migration/integrity failure, persistent stale
lease or unfinished-age growth, duplicate-ID conflict, timeout spike, invalid
boundary response, or sustained pool exhaustion. Response-loss tests must
produce one takeover or duplicate replay and one logical effect.
