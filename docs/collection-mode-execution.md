# Collection mode switching

An owner can switch an existing synced collection in place between `private`
(end-to-end encrypted) and `cloud_copy` (hosted and escrow Workers hold keys so
web apps and agents work while the owner's devices are offline), keeping its
collection ID and enrolled user devices.

Execution routes (`/prepare` and `/finish`) are gated off by default
(`MDBASE_NEXT_COLLECTION_MODE_EXECUTION=0`). Setting
`MDBASE_NEXT_COLLECTION_MODE_EXECUTION=1` alongside
`MDBASE_NEXT_PRIVATE_BOOTSTRAP=1` and `MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1`
mounts them directly from configuration, with no startup Worker HTTP probe.
`GET /v1/next/collections/:id/mode` reports `execution_available` according to
whether the execution routes are mounted.

**Deploy ordering.** Hosted and escrow Workers carry
`/internal/v1/collection-mode/{ready,retire}` and advertise
`collection_mode_switch_v2` on service log-token refresh. Deploy `v2`-capable
Workers before enabling `MDBASE_NEXT_COLLECTION_MODE_EXECUTION=1`, and disable
the server flag before rolling either Worker back to a build without those
handlers. Calls from `/finish` to a Worker that lacks a handler or is
temporarily unreachable fail with retryable `503 not_ready` rather than a
terminal error.

## API and authorization

Authenticated next accounts may initiate, inspect, cancel or abandon a switch
using an active account session or an enrolled owner desktop/CLI connector. App
grants and installation credentials never confer mode-change authority. Every
request, retry and status read revalidates the credential, active account,
owner membership, and non-deleted / non-left-sync collection under the
collection advisory lock and row lock. All responses are `cache-control: no-store`.

- `POST /v1/next/collections/:id/mode`: strict JSON
  `{ "request_id": "<non-nil UUID>", "target_mode": "private" | "cloud_copy" }`.
  Returns `202` with collection/request IDs, `current_mode`, `source_mode`,
  `target_mode`, and `phase`. Retrying the same `request_id` and `target_mode`
  returns the same durable operation; reusing `request_id` for a different
  target returns `409 mode_request_conflict`; a second active operation returns
  `409 mode_change_in_progress`; an unrekeyed abandoned Private switch returns
  `409 mode_abandoned`; a request for the current mode returns
  `409 mode_already_current`. Refusals mutate nothing.
- `GET /v1/next/collections/:id/mode`: current mode, `execution_available`, and
  the active `change` (or an unrekeyed `abandoned` switch, or `null`).
- `GET /v1/next/collections/:id/mode/:requestId`: single operation status
  (`404` if unknown).
- `DELETE /v1/next/collections/:id/mode/:requestId`: idempotent pre-publication
  cancellation. Refuses `409 mode_already_published` once an outbox batch is
  assigned.
- `POST /v1/next/collections/:id/mode/:requestId/prepare` and `/finish`: native
  owner desktop/CLI device only, authenticated with a single-use challenge
  Ed25519 proof binding connector, device, collection, request, direction,
  stage, epoch, seq, chain hash, and preflight members.
  - `/prepare` arms the capability floor (Cloud copy → Private), queues the
    transition policy item into the existing policy outbox, and returns `202`
    with `phase: "waiting_for_token_expiry"` (+ `retry_at`),
    `phase: "publishing_policy"` when the foreground outbox wake is deferred
    (the durable outbox publishes asynchronously), or `phase: "finishing"`.
  - `/finish` validates either the first qualifying `CloudCopyOff` rekey after
    the switch policy (adjacent or non-adjacent, matching `source_epoch + 1`
    and chain hash; native replicas own signature, unwrap/commitment, and
    frozen-set verification) plus hosted/escrow cache retirement
    (Cloud copy → Private), or hosted/escrow native readiness
    (Private → Cloud copy). Returns `503 not_ready` while Workers catch up and
    `200 { request_id, phase: "complete" }` once complete.
- `POST /v1/next/collections/:id/mode/:requestId/abandon`: owner session or
  surviving native owner. Mounted whenever `MDBASE_NEXT_PRIVATE_BOOTSTRAP=1`,
  including when execution is disabled.

Operation phases: `waiting_for_device`, `waiting_for_devices`,
`waiting_for_token_expiry` (with `retry_at`), `publishing_policy`, `finishing`,
`complete`, `cancelled`, and `abandoned`.

## Capability gate and token drain

- Producers (daemon relay/registration/bootstrap/log-token refresh, SDK
  registration/bootstrap/log-token refresh, and hosted/escrow Worker log-token
  refresh) advertise `collection_mode_switch_v2`.
- The control plane records a monotonic historical bit
  (`next_devices.mode_switch_advertised`) only for `v2` advertisements.
- Cloud copy → Private arming requires every active keyed user device in the
  signed native preflight (including offline devices) to have advertised `v2`.
  Missing devices return `409 mode_devices_need_update` with
  `devices: [uuid, ...]`; clients resolve device names from the account's
  device listing so the owner can update or revoke them.
- Once armed, `next_collections.mode_floor_raised_at` is recorded permanently
  and never reset. Every user and service role-0 log-token mint checks the
  presenting request's current capabilities (never the historical bit) and
  refuses clients without `collection_mode_switch_v2` with
  `409 mode_update_required`.
- Private policy publication waits `LOG_TOKEN_LIFETIME_MS` (15 minutes) from
  `mode_floor_raised_at` so all pre-floor cached log tokens expire before the
  `e2e` policy item publishes.
- The Cloud copy → Private policy item occupies its own outbox batch bound to
  `mode_source_head`. If the log head moves before append, `/prepare` returns
  `409 mode_source_changed` and the daemon retries with a fresh preflight.

## Daemon, CLI, and UI behaviour

- **Automatic daemon execution.** Once an owner confirms a switch on a keyed
  owner device, `mdbn-daemon` drives the retained request through token drain,
  policy publication, native rekey or service key handover, and `/finish`
  automatically in the background without manual `--resume` commands.
- **Retryable refusals do not cancel.** In-progress and transient responses
  (`202 publishing_policy`, `202 waiting_for_token_expiry`, `409 mode_source_changed`,
  `429`, `503 not_ready`) keep the switch active and retry rather than
  cancelling it.
- **CLI.** `mdbase sync mode` and `mdbase sync mode-status` present
  human-readable progress and guidance (with `--json` for machine output).
- **Portal and Desktop.** Desktop Details and Portal Storage & sync share the
  mode control, shown to owners when `execution_available` is true. It displays
  the source mode while a switch is in progress, polls active switches, resolves
  blocking device names from account devices, warns that connected apps must be
  reconnected, and exposes the owner abandon recovery flow when a published
  Cloud copy → Private switch is stuck in `finishing` because the starting
  device is unavailable.
- **Owner handover and receivers (Private → Cloud copy).** Only explicit
  durable local Cloud consent on a keyed owner device releases the current
  epoch to newly generated hosted/escrow devices via ordinary `key_grant` items.
  Other devices automatically select Cloud reading on observing a valid
  current-epoch service grant signed by a currently trusted active Private
  owner, without creating source consent. See
  [private-cloud-handover.md](private-cloud-handover.md).
- **App grants are revoked on mode change.** Switching modes in either
  direction revokes active app grants approved for the prior mode
  (`reauthorization_reason = 'collection_mode_changed'`), revoking their access
  and refresh tokens and queuing log `grant-revoke` ops. Connected apps and MCP
  clients must be reconnected after the switch.

## Published Private recovery (abandon)

While a published Cloud copy → Private policy item has no observed item in the
next slot, the policy emitter holds ordinary policy mutations with
`409 collection_mode_change_in_progress`. Observing any control item at `p + 1`
releases the policy hold (position evidence only; never readiness or completion).

If the starting owner device is lost after policy publication and before its
rekey lands, an owner session (via Portal or Desktop) or surviving native owner
can `POST /v1/next/collections/:id/mode/:requestId/abandon`. Abandonment:

- fails with `409 mode_rekey_observed` if a rekey is already observed at `p + 1`;
- marks the switch terminal as `abandoned`, releases the policy hold, removes
  `next_service_devices` rows, and sets `next_collections.sync = 'private'`
  without publishing a rekey or revoking history;
- unblocks ordinary policy mutations (such as revoking the lost device before
  rotation);
- leaves Private on the epoch the services held until a surviving frozen owner
  automatically authors the excluding `CloudCopyOff` rekey (see
  [collection-mode-switch-trust.md](collection-mode-switch-trust.md)).

Until a rekey follows the abandoned policy item (or a later change completes),
`GET /v1/next/collections/:id/mode` reports `phase: "abandoned"` and
`POST /v1/next/collections/:id/mode` refuses new switches with
`409 mode_abandoned`. The control-plane log scan is bounded and fails closed as
`abandoned` if the log is unavailable.

## Known limits

- **Snapshot install across a Cloud copy → Private switch.** Snapshot/control
  read-ahead is never a settled applied prefix and cannot mint switch-set
  acceptance. A device offline long enough to require a snapshot install across
  a Cloud copy → Private switch must re-establish trust through normal Private
  trust (account key or device approval).
- **App installations enrolled while Cloud copy (`device_enrolled_differently`).**
  An `app-runtime` installation that enrolled while a collection was Cloud copy
  has an enrolment op without `sasCommit`. If the collection switches to Private
  and the user later grants Private device access to that same installation,
  enrolment returns `409 device_enrolled_differently`. Remove that
  installation's access and reconnect it as a fresh device (see
  [installation-private-device.md](installation-private-device.md)).
- **Outside keyed device racing a released slot.** After an abandoned slot is
  released, a keyed device outside the frozen switch set can author an ordinary
  rekey first, which consumes the switch-set exception and requires normal
  Private trust recovery.
