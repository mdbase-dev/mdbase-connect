# Collection mode operation — phase 1

This is the durable owner-intent/status foundation. Direction-specific key work
is not connected yet. **A request remains `waiting_for_device`; accepting it
neither changes policy nor changes the collection's privacy boundary.** Do not
ship UI claiming this phase alone implements switching.

Authenticated next accounts may use an active account session or an enrolled
owner desktop/CLI connector. App grants and installation credentials do not
confer mode-change authority. Every request, retry and status read revalidates
the original credential, active account, owner membership and current collection.
Account-cookie requests retain the server's existing origin checks.

- `POST /v1/next/collections/:id/mode`: strict JSON
  `{ "request_id": "<non-nil UUID>", "target_mode": "private" | "cloud_copy" }`.
  Returns 202 with collection/request IDs, current/source/target modes and phase.
  Retrying the same ID and target returns the same durable operation. Reusing
  the ID for a different target returns 409 `mode_request_conflict`; a second
  active operation returns 409 `mode_change_in_progress`. A request for the
  current mode, without a matching earlier operation, returns
  `mode_already_current`. These refusals do not mutate anything.
- `GET /v1/next/collections/:id/mode`: current mode and active `change`, or null.
  This recovers progress when another client initiated the operation.
- `GET /v1/next/collections/:id/mode/:requestId`: one operation's status. An
  unknown operation is 404. All responses are `no-store`.

Intent is inserted under the same collection advisory lock and row lock as
owner deletion/bootstrap. The transaction checks leave-sync/deletion denials
before insertion or status. A deletion that follows intent wins: retries cannot
revive the collection. Future executors must recheck these same guards at each
commit boundary; intent is not a standing authorization or liveness permit.
There is no server leave-sync writer at this revision; the existing
`left_sync_at` row is checked under `FOR UPDATE`, which also serializes direct
or future leave-sync updates.

The new ledger links an operation to the existing policy outbox, not another
append queue. Status distinguishes unpublished/sending/parked/lost policy
(`publishing_policy`) from an acknowledged, non-lost batch (`finishing`). Neither
is completion. The later executor must record completion only after the required
verified rekey/handover and cleanup evidence. No phase-1 code queues a transition
policy item or writes a completion timestamp: usable-device and trust rules must
be implemented first.

Tests use dedicated disposable local PostgreSQL with per-suite schemas. They
cover both requested directions, account/device authorization, durable intent
without policy mutation, transaction failure before/after commit, restart, lost
response, duplicate/concurrent/conflicting requests, ledger status, deletion
and leave-sync ordering, and current-owner revalidation. They are **not**
SDK/daemon end-to-end conversion tests; those belong to the later phases.
