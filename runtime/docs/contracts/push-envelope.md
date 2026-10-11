# Push delivery envelope

Status: v1, 2026-10-12. It records the bytes Connect's notification service already sends.

A push from mdbase wakes an app installation. Every producer uses this one envelope: fired
timers (`timer-service-api.md` §4) and connector notification signals. It is JSON. It adds no
`mdb-cbor/1` wire types.

## 1. Principles

- **Opaque.** The envelope says only that a criterion of the app fired. It never carries:
  - record, timer, namespace or collection identifiers;
  - timer `data`;
  - record content.

  A push passes through Google, Apple and browser push services, and they must learn
  nothing about the collection.
- **App-owned meaning.** `criterion_id` is the id of a notification criterion in the app's
  own manifest. Only the app gives it meaning, for example "a task reminder is due". On
  wake, the app reads current state through its connection. For reminders, that means
  `timers.list`/`reconcile` and its records.
- **Untrusted text.** `presentation` is the criterion's static manifest text, chosen by the
  app's developer. Treat it as untrusted text and never as markup. A compromised control
  plane can send any text.
- **A hint, not a fact.** The same signal may arrive more than once, late (up to the 24 h
  push TTL) or not at all. Deduplicate on `signal_id`.

## 2. Envelope v1

### 2.1 Web Push

The body is encrypted `aes128gcm`. It is sent with TTL 86400 and urgency `normal`.

```json
{
  "type": "mdbase.notification",
  "version": 1,
  "signal_id": "tmr_…",
  "criterion_id": "task.reminder",
  "cursor": "tmr_…",
  "presentation": { "title": "Task reminder", "body": "…", "tag": "…" }
}
```

| Field | Rule |
|---|---|
| `type` | `"mdbase.notification"` |
| `version` | integer `1` |
| `signal_id` | 1–256 visible ASCII characters. The idempotency key. For timers it is the fired-timer event id: `tmr_` followed by 32 base64url characters. |
| `criterion_id` | a manifest identifier `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`, at most 100 characters |
| `cursor` | 1–256 visible ASCII characters. Opaque: never parse it. For timers it equals `signal_id`. |
| `presentation.title` | 1–80 characters |
| `presentation.body` | optional, at most 160 characters |
| `presentation.tag` | optional, 1–80 characters. It collapses notifications that share the tag. |

### 2.2 FCM (Android and APNs through FCM)

- The `notification` carries `{title, body?}` from `presentation`. The OS shows it.
- The `data` map carries the envelope without `presentation`. Every value is a string:
  `{type, version: "1", signal_id, criterion_id, cursor}`.
- Android uses priority `high`, channel `mdbase-updates` and `tag`. APNs uses `thread-id`
  set from `tag`.

### 2.3 Webhook

A signed webhook wraps the same object:
`{type: "mdbase.notification.webhook", version: 1, delivery_id, connection_id, notification}`.

## 3. Versioning

- `version` is a major version. A parser must refuse a version it does not know and must not
  guess. The SDK reports such a version as `upgrade_required`. A malformed envelope is
  `invalid_request`.
- **Within v1**, producers may add optional fields, and parsers ignore unknown fields. No
  field may change meaning.
- **A new major version** goes only to channels whose registration lists it, through a
  future `envelope_versions` field on channel registration. An installed app therefore
  never receives a version it cannot parse. Until that field exists, every producer sends
  v1.

## 4. SDK

`@mdbase-dev/sdk/notifications` imports no Worker, wasm or client code. The same exports are
also on the root entry. It provides:
- `parseMdbasePush(value)`: an object, a JSON string or `PushMessageData`.
- `parseMdbaseNativeNotification(data)`: FCM/APNs `data`. The result has
  `presentation: null`.
- `readMdbaseNotificationData(data)`: the envelope kept on a shown notification or a
  native tap, or `null`.
- `showMdbaseNotification(registration, value, {icon?, badge?})`: validates and shows the
  push. The notification's `data` is the §2.2 map, with `version` as a number.
- `handleMdbasePush(event, options?)`: a service-worker `push` handler. It returns `false`
  for a push that is not an mdbase notification, so the app can handle its own pushes. Only
  a newer envelope version (`unsupported_push_version`) that still has a valid
  `presentation` is shown anyway, without `data`. A malformed v1 envelope and a failed
  `showNotification` reject the `waitUntil` promise and show nothing.
- `handleMdbaseNotificationClick(event, {url?, scope?})`: a `notificationclick` handler. It
  focuses an open app window within `scope` and posts
  `{type: "mdbase.notification.click", notification}` to it. If no app window is open, it
  opens `url`, which defaults to the registration scope. `url` and `scope` must be on the
  service worker's own origin (`invalid_request`/`click_target_cross_origin` otherwise);
  without a known origin only a root-relative path is accepted.

Channels are registered through the application connection's `timers`
(`registerWebPush()`, `registerFcm({token})`). The criteria default to every timer criterion
the manifest declares. The service worker defaults to `navigator.serviceWorker.ready`.
