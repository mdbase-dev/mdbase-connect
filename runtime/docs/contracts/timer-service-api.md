# Timer service API

Status: draft for review, 2026-10-04.

The timer service schedules one-shot, **opaque** timers for an app's grant. When a timer
is due, it wakes the app's push installations through the grant's notification criterion.
It is part of the control plane. It is the same in every collection state (on this
device, synced, synced end-to-end), and no replica or log is involved.

This is a **JSON over HTTPS** API, like the control plane's routing endpoint
(`control-plane.md` §5.2). It adds no `mdb-cbor/1` wire types, so `wire.cddl`, the golden
fixtures and `conformance/wire/cddl-pending.txt` are unchanged.

## 1. Authentication and authorization

- **Apps** authenticate with their OAuth access token (`Authorization: Bearer`), the
  same token they use for routing and push channels.
- **The grant must be usable:**
  - it is active and activated, and the user isn't suspended;
  - it holds the capability `background.schedule` (`policy.md` §5);
  - where approval is required (`policy.md` §5.1: `e2e`, a `cloud-copy` without a keyed
    escrow, and device-located logs), a device has approved it, and the approval kept
    `background.schedule`.

  Otherwise the call fails with `403 forbidden`.
- **Collection.** The `:collection` in the path must be the grant's collection.
  Otherwise the call fails with `403 forbidden`.
- **Criterion.** `criterion_id` must be in the grant's notification-criteria snapshot,
  with event `mdbase.runtime.timer.fired` and a version requirement that matches
  `1.0.0`. Otherwise the call fails with `403 forbidden`, reason
  `timer_criterion_not_authorized`.
- **Internal compatibility routes** carry the same bodies, with the grant named
  explicitly:
  - `/internal/v1/next/timers/:grant/...` for the hosted old-SDK shim, with the internal
    bearer;
  - `/v1/next/devices/timers/:grant/...` for the daemon's legacy-envelope layer. It
    requires device proof of possession (a signature by the registered `sign_pk` over
    a fresh challenge, or a bound relay socket), and the grant must belong to a
    collection that device hosts. It isn't deployed before then.
- **The provider's internal credential** acts only for `cloud-copy` grants, on the
  shim routes, the import route and the hosted copy. Any other grant is `403
  forbidden`.

## 2. Types

```text
namespace   = string, 1..64,  [A-Za-z0-9._-]
timer-id    = string, 1..128, [A-Za-z0-9._:-]
criterion   = string, 1..100
instant     = RFC 3339 string with an offset or Z; stored and returned in UTC with milliseconds and Z

desired-timer = { "id": timer-id, "fire_at": instant, "data"?: json }
timer = {
  "id": timer-id, "criterion_id": criterion, "fire_at": instant,
  "generation": uint, "status": "scheduled" | "firing" | "fired" | "cancelled",
  "created_at": instant, "updated_at": instant, "fired_at": instant | null,
  "data"?: json
}
```

**`data`:**
- it is at most 16 KiB as serialized JSON;
- it is accepted **only for synced (`cloud-copy`) collections**. Elsewhere a non-null
  value fails with `400 invalid_request`, reason `timer_data_not_permitted`;
- it is erased when the collection leaves `cloud-copy`.

## 3. Operations

The base path is `/v1/next/collections/:collection/timers`. Field names follow
Connect's legacy operations, so SDK shapes don't change.

| Method and path | Body | Result |
|---|---|---|
| `GET /:namespace` | — | `{namespace, timers: [timer]}`: active and recent (≤ 7 days) timers |
| `PUT /:namespace/:id` | `{criterion_id, fire_at, data?}` | `timer` |
| `DELETE /:namespace/:id[?generation=n]` | — | `{namespace, id, cancelled: bool}` |
| `POST /:namespace/reconcile` | `{criterion_id, timers: [desired-timer]}` | `{namespace, timers: [timer], cancelled_ids: [timer-id]}` |

**Identity** is `(grant, namespace, id)`. Every operation is idempotent, and a retry
with the same body is safe.

**`put`:**
- If the stored timer is not cancelled and equals the request on `fire_at`,
  `criterion_id` and `data`, it is a **no-op**: the generation and status stay as they
  are, so a timer that has already fired is not re-armed.
- Otherwise the generation increments, the status becomes `scheduled`, `fired_at`
  becomes `null` and `created_at` is kept.

**`cancel`:**
- It returns `cancelled: false` when:
  - the timer is missing;
  - `generation` is given and doesn't match;
  - the status is not `scheduled` or `firing`.
- Otherwise the status becomes `cancelled`.

**`reconcile`** atomically replaces the active set of `(grant, namespace)`:
- Timers in the set are put as above. Duplicate ids fail with `400 invalid_request`.
  There are at most 10,000 timers per call.
- Active timers that are absent from the set are cancelled and listed in
  `cancelled_ids`.
- Fired and cancelled timers that are absent from the set are left alone.
- An empty set cancels the namespace.
- Other namespaces and other grants are never touched.

**Quotas:**
- at most 10,000 active timers per `(grant, namespace)`, and 50,000 per grant
  (`413 too_large`, `details.limit`);
- at most 60 write calls per grant per minute (`429 rate_limited`, `retry_after_ms`).

## 4. Firing and delivery

- **Firing.** The service fires a timer once its `fire_at` ≤ the control plane's clock.
  An overdue timer fires once, however late.
- **Re-checks.** In the same transaction it re-checks that the grant is still usable
  and that the criterion is still in its snapshot. If either fails, the timer becomes
  `cancelled` and no signal is sent.
- **Event.** Firing a generation appends exactly one **fired-timer event**. It is the
  single output of the service, and every consumer reads it: notifications today, and
  a workflow runner later. Its data follows `mdbase.runtime.timer.fired@1.0.0`:
  `{timer_id, generation, scheduled_for, fired_at, late_by_ms, data}`.
  - `data` is non-null only for `cloud-copy` collections. Local and end-to-end
    consumers get only the ID and the time.
  - The event ID is
    `"tmr_" ‖ base64url(H("mdbase/v1/timer-signal", grant ‖ namespace ‖ id ‖ u64be(generation)))[0..32]`.
  - Each consumer handles an event exactly once, by recording a receipt in the same
    transaction as its effect.
- **Signal.** The notifications consumer turns each event into one notification signal.
  Its `criterion_id` is the timer's criterion, and its `signal_id` and `cursor` are
  both the event ID.
- **Delivery** follows Connect's notification service: Web Push, FCM, APNs through FCM,
  or a signed webhook.
- **Payload.** It is
  `{type: "mdbase.notification", version: 1, signal_id, criterion_id, cursor,
  presentation}`. The `presentation` is the criterion's static manifest text.
- **What a push never carries:** timer IDs, `data`, record IDs or content.

## 5. Lifecycle

- **Revocation.** Revoking or deleting a grant cancels its timers.
- **State changes** keep the timers. Leaving `cloud-copy` erases `data`. Backups keep
  it until they expire.
- **Retention.** `fired` and `cancelled` timers, events and their receipts are deleted
  after 7 days, once every consumer has handled the event. Every event is deleted
  after 14 days regardless, and consumer lag over an hour raises an alert.
- **Supersession** needs a `supersedes` declaration from the same developer account,
  the consent screen saying so, and matching channel targets. It isn't
  not implemented yet, so re-consent starts empty.

## 6. Errors

Errors use Connect's envelope:
`{"error": {"code", "message", "details"?: {"reason"?, "limit"?, "retry_after_ms"?}}}`. Each `code` is
one of the 15 codes of `replica-client-api.md` §9, which the SDK maps the same way:
- `invalid_request` (400);
- `unauthenticated` (401);
- `forbidden` (403);
- `not_found` (404, for an unknown collection);
- `too_large` (413);
- `rate_limited` (429);
- `unavailable` (503, when the feature is off or the database is unavailable);
- `internal` (500).
