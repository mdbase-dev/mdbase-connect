# Runtime-backed notifications

Connect notifications wake an application through the platform Web Push
service even when the application is not running. Applications declare
criteria; the collection authority evaluates them with the mdbase Runtime and
sends an opaque signal to the Connect control plane. The control plane owns
device subscriptions and durable push delivery, but it never receives a record
path, frontmatter, body, or runtime event payload.

## Application manifest

Notifications require application manifest version 2:

```json
{
  "manifest_version": 2,
  "name": "TaskNotes",
  "homepage": "https://tasks.example",
  "redirect_uris": ["https://tasks.example/auth/mdbase/callback"],
  "requirements": {
    "contracts": [{ "id": "tasknotes.task", "version": 1 }]
  },
  "notifications": {
    "criteria": [{
      "id": "task.ready",
      "event": {
        "id": "mdbase.record.modified",
        "version": 1
      },
      "if": {
        "language": "cel",
        "expression": "\"status\" in event.payload.changed_fields"
      },
      "debounce": "5s",
      "minimum_interval": "15m",
      "presentation": {
        "title": "A task is ready",
        "body": "Open TaskNotes to review it.",
        "tag": "task-ready"
      }
    }]
  }
}
```

Criteria use canonical runtime event contracts and CEL. Presentation copy is
static manifest data; expressions cannot interpolate private record content
into a push message. Each grant stores an exact copy of the criteria locally or
at the hosted authority, which remains the final authorization boundary
immediately before notification dispatch.

`timer.fired` is the portable scheduling event. The authority stores one-shot,
generation-fenced timers durably and fires overdue timers once after restart.
An application can use that event for reminders without remaining connected.

## Browser and mobile registration

Register a service worker, then enable all declared criteria or an explicit
subset:

```ts
import { MdbaseConnect } from "@mdbase/connect";

const worker = await navigator.serviceWorker.register("/service-worker.js");
await connect.registerNotifications({
  serviceWorker: worker,
  criteria: ["task.ready"]
});
```

Channel creation and criterion selection are one control-plane transaction.
Calling `registerNotifications` again refreshes an expired browser subscription
and atomically replaces the selected criteria for the same installation.

The service worker validates the push envelope and displays its static
presentation:

```ts
import { showMdbasePushNotification } from "@mdbase/connect";

self.addEventListener("push", (event) => {
  event.waitUntil(
    showMdbasePushNotification(
      self.registration,
      event.data?.json()
    )
  );
});
```

The payload contains only `signal_id`, `criterion_id`, an opaque authority
cursor, and static presentation. When the user opens the application, use the
criterion and cursor as a wake-up hint and query the collection through the
ordinary authorized API. Do not treat a push as collection data or proof that
the underlying record still matches.

Call `connect.unregisterNotifications(worker)` when the user disables
notifications. This removes the server channel before unsubscribing the
browser, so a transient server error can be retried without orphaning a live
channel.

Native iOS and Android SDK adapters can register APNs or FCM channels against
the same installation and criterion model. The current public SDK implements
standards-based Web Push, which also covers installed PWAs.

## Delivery and recovery

The authority journals the triggering event and runtime run atomically. Action
invocation IDs become signal IDs, making retries idempotent. The control plane
creates one delivery per active installation and uses leases, exponential
backoff, and permanent-endpoint disabling. Local authorities retain their
runtime store in the connector's private state directory; hosted authorities
use a collection-fenced PostgreSQL namespace.

Revoking a grant disables both evaluation and delivery. A manifest
rediscovery may narrow or remove criteria, but never broadens an existing
grant's collection access.

## Deployment

The control plane requires one VAPID keypair:

```text
MDBASE_CONNECT_VAPID_SUBJECT=mailto:ops@example.com
MDBASE_CONNECT_VAPID_PUBLIC_KEY=...
MDBASE_CONNECT_VAPID_PRIVATE_KEY=...
```

The hosted provider also requires
`MDBASE_CONNECT_CONTROL_PLANE_URL` and the same existing internal provider
credential used by the control plane. The callback carries only opaque signal
metadata. `MDBASE_CONNECT_HOSTED_NOTIFICATION_INTERVAL_SECONDS` controls
durable source-outbox recovery and defaults to five seconds. Self-hosters may
omit VAPID configuration to disable public push registration while retaining
the rest of Connect.
