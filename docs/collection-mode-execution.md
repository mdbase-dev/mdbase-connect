# Collection mode controller checkpoint — not enabled

This branch composes switch-set trust and owner handover with native HTTP proofs,
a step/resume controller, service readiness and rebuildable-cache retirement.
It is not a shippable conversion: `registerCollectionModeExecution` is deliberately
not called by the server and no interface controls are exposed yet.

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
`--resume`) and `sync mode-status`; management SDK methods submit owner intent or
read status only, never produce native proofs. Desktop IPC/preload bindings are
present but no controls are rendered. Only fresh durable native Cloud consent enables
owner handover. Existing-epoch grants recover authenticated history; bounded
existing keyring replay repairs partial history without changing policy/trust.
Service readiness is not app admission, especially for escrow. Cache retirement
preserves migration ledgers, checks physical identity and public device marker,
and makes no physical-erasure claim.

The owner's Cloud choice now uses the same identity/genesis-bound journal for
both host files. Both files commit before core source consent can release keys.
Startup retains the Cloud journal until the guarded actor accepts that consent;
repeated recovery preserves the Private history witness. A read-only owner
preflight does not itself create consent. Existing account serialization prevents
an old status replay from replacing a later foreground choice.

Still required before enabling: non-source-device Cloud reconciliation (a server
flag cannot set local service trust or owner source consent), known-before-publication failure/cancel
reconciliation, desktop/portal controls, complete PG execution
races and real Worker/SDK/daemon conversion E2E. Passing unit/transport tests are
not completed conversions.

## Scoped checks

- Real isolated PG: capability/TTL/prefix-retry controller tests plus existing
  mode API, mint, bootstrap, device, service and outbox regressions.
- Replica/daemon Rust libraries and all-targets clippy; real default runtime WASM
  for SDK integration tests; Worker types and Node tests.
- `rpnpm --node 24.15.0 --class test test:mode-sdk` and `test:mode-worker` dispatch
  the existing locked npm subprojects; scratch stays under the worktree. Build
  their real WASM inputs using `rcargo` first. No deployment is performed.
