# Collection mode controller — qualification pending

This branch composes switch-set trust and owner handover with native HTTP proofs,
a step/resume controller, service readiness and rebuildable-cache retirement.
It is not yet a shippable conversion. Execution remains unregistered and controls
remain hidden pending complete controller and managed LAB qualification. Controls
follow actual route availability, not a new rollout flag. Do not mark this draft
implementation ready for release before the outstanding acceptance matrix passes.

## Capability gate and token drain

- The existing relay capability array is reused. New native/SDK registration,
  bootstrap and token refresh requests advertise `collection_mode_switch_v1`.
  The CP records only a monotonic per-device historical advertisement bit.
- Arming requires all active keyed user devices S in the signed native preflight
  to have advertised, including offline devices. Refusal identifies missing
  devices so a client can offer update or revocation.
- The collection floor is represented by its first raised timestamp, never reset
  by retries or direction changes. Every existing user/service role-0 mint checks
  the presenting request's current capability, NOT the historical advertisement.
- Private policy publication waits until the first raised timestamp plus
  `LOG_TOKEN_LIFETIME_MS`. Neither the Private switch item nor its adjacent owner
  rekey is published inside the old-token window. Existing keys are untouched.
- The native member list is signed with its applied prefix. The mode policy owns
  one outbox batch. Existing conditional append prevents publication at a different
  head; a head move requires a fresh native preflight. This avoids maintaining a
  second keyed-device reducer in the CP or trusting a stale S while key grants
  arrive during the drain.
- Downgrading a previously advertised identity is unsupported. Current-session
  mint checks still refuse a binary without support; pre-floor cached tokens
  expire before Private policy publication. No per-write fence, new token format,
  collection-log wire fields or weaker trust/adjacency rule is added.

No switch has shipped. Phase 1 is intent only; there is no already-applied-switch
upgrade case to implement.

The CP regression refuses unadvertised B at arming and proves publication waits
across a restart until the maximum old-token lifetime has elapsed. The raw engine
fixture `raw_legacy_rekey_is_not_a_qualifying_private_cutover` deliberately bypasses
token admission and retains the strict wrong-reason refusal, rather than changing
policy validity to hide the old producer behavior.

## Other boundaries

Native HTTP proofs bind collection, request, direction, stage, actual epoch,
prefix and preflight membership. Native mode mutation requires the existing
privileged owner control connection. The CLI exposes `sync mode` (including
`--resume` and pre-publication `--cancel`) and `sync mode-status`; management SDK
methods submit/cancel owner intent or read status only, never produce native proofs. Desktop IPC/preload bindings are
present. Desktop Details and portal Storage & sync share an inline mode control,
including pending/retry state and missing-device diagnostics. It stays hidden
unless the owner status reports an actually registered executor route; older
servers and non-owner responses expose no control. There is no new rollout flag. Only fresh durable native Cloud consent enables
owner handover. Existing-epoch grants recover authenticated history; bounded
existing keyring replay repairs partial history without changing policy/trust.
Service readiness is not app admission, especially for escrow. Cache retirement
preserves migration ledgers, checks physical identity and public device marker,
and makes no physical-erasure claim.

The owner's Cloud choice now uses the same identity/genesis-bound journal for
both host files. Both files commit before core source consent can release keys.
A separate durable request preserves exact request identity and cancellation
across uncertain HTTP outcomes. Source recovery also binds the native Private
generation: a later qualifying Private switch invalidates an older source choice.
Status/replay never resurrect source consent; a terminal completed request is not
a new gesture. Recovery preserves the Private history witness. A read-only owner
preflight does not itself create consent. Existing account serialization prevents
an old status replay from replacing a later foreground choice.

Other devices now select Cloud reading automatically from an ordinarily valid
current-epoch service grant signed by a currently trusted, active Private owner.
This local, applied-prefix-bound receiver selection never sets source consent,
even if a viewer becomes an owner. Native projection uses its own receiver
journal disposition, never `ChooseCloud`; the UI shows only a passive owner-device
notice. A remote mode flag, untrusted/self-rooted stranger, revoked signer, or an
editor grant cannot select reading. No new wire statement or trust exception.

Pre-publication cancellation is accepted only before outbox batch assignment;
assigned/unknown publication is not rolled back. Tombstones make cancellation
idempotent even when the first intent reply was lost. Original signed genesis
verification is independent of the current join mode; creation still verifies
its selected genesis mode.

Local conversion evidence includes real native sockets/SQLite with receiver
restart, SDK reads/writes in both directions, and actual Worker/WASM/SQLite
readiness, revocation, retirement retries and cold process restart. The shared
control has real-browser interruption/cancel/retry coverage with synthetic
boundary responses. None of these is managed LAB conversion acceptance. That
matrix (two devices in each direction, including a named older-capability
blocker) remains outstanding; do not release or mark this implementation ready.

## Scoped checks

- Real isolated PG: capability/TTL/prefix-retry controller tests plus existing
  mode API, mint, bootstrap, device, service and outbox regressions.
- Replica/daemon Rust libraries and all-targets clippy; real default runtime WASM
  for SDK integration tests; Worker types and Node tests.
- `rpnpm --node 24.15.0 --class test test:mode-sdk` and `test:mode-worker` dispatch
  the existing locked npm subprojects; scratch stays under the worktree. Build
  their real WASM inputs using `rcargo` first. No deployment is performed.
