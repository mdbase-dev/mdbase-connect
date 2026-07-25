# Runtime-backed notifications

Connect notifications wake an application even when it is not running.
Applications declare criteria; the collection authority evaluates them with
the mdbase Runtime and sends an opaque signal to the Connect control plane.
Connect never receives a record path, frontmatter, body, or runtime event
payload.

Delivery is deliberately separate from evaluation. An application may use any
combination of:

- standards-based Web Push for browsers and installed PWAs;
- Connect-managed Firebase Cloud Messaging (FCM) for native iOS and Android;
- a signed developer webhook that sends through the application's own
  notification infrastructure.

## Bundled application declaration

Notifications use the bundled v1 application manifest:

```json
{
  "manifest_version": 1,
  "id": "dev.mdbase.tasks",
  "name": "Worklog",
  "homepage": "https://tasks.example",
  "redirect_uris": ["https://tasks.example/auth/mdbase/callback"],
  "requirements": {
    "contracts": [{ "id": "example.work-item", "version": 1 }]
  },
  "notifications": {
    "criteria": [{
      "id": "task.changed",
      "event": {
        "id": "mdbase.record.modified",
        "version": 1
      },
      "if": {
        "$expr": "\"task\" in event.payload.types"
      },
      "debounce": "5s",
      "minimum_interval": "1m",
      "presentation": {
        "title": "Tasks changed",
        "body": "Open Worklog to see the latest changes.",
        "tag": "task-changes"
      }
    }],
    "native_delivery": {
      "mode": "managed_fcm",
      "firebase_project_id": "worklog-production"
    }
  }
}
```

Criteria use canonical runtime event contracts and CEL. Presentation copy is
static manifest data; expressions cannot interpolate private record content
into a notification. Each grant stores an exact copy of the criteria locally
or at the hosted authority, which remains the final authorization boundary
immediately before dispatch.

The authorized grant stores an exact snapshot of each criterion. Rediscovery
may remove a criterion that disappeared or changed, but it never adds or
rewrites one on an existing grant. Registration returns
`notification_reauthorization_required` if the application selects a new or
changed criterion; run the ordinary authorization flow again so the user can
review it.

`timer.fired` is the portable scheduling event. The authority stores one-shot,
generation-fenced timers durably and fires overdue timers once after restart.
An application can use that event for reminders without remaining connected.
Timer operations are exact grant permissions, and every timer is namespaced
under the calling grant before it reaches Runtime. A timer can therefore wake
only the criterion that created it, even when several applications use the
same collection authority.

Declare a `timer.fired` criterion, request the timer operations, and reconcile
the desired namespace whenever application state changes:

```ts
await connection.reconcileTimers({
  namespace: "task-reminders",
  criterion_id: "task.reminder",
  timers: [{
    id: "task-123:reminder-1",
    fire_at: "2026-07-25T10:00:00Z",
    data: { kind: "task_reminder" }
  }]
});
```

`reconcileTimers` is atomic: unchanged timers retain their generation and fired
state, changed timers receive a new generation, new timers are scheduled, and
active timers omitted from the desired set are cancelled. `putTimer`,
`cancelTimer`, and `listTimers` support incremental management. Timer IDs and
optional data remain at the authority; neither is copied into the push signal.
Namespaces contain letters, numbers, dots, underscores, and dashes, and one
reconciliation accepts at most 10,000 timers with up to 16 KiB of private data
per timer.

## Browser registration

Register a service worker from a user gesture, then enable all declared
criteria or an explicit subset:

```ts
import { MdbaseConnect } from "@mdbase/connect";

const worker = await navigator.serviceWorker.register("/service-worker.js");
await connection.registerNotifications({
  serviceWorker: worker,
  criteria: ["task.changed"]
});
```

Channel creation and criterion selection are one control-plane transaction.
Calling `registerNotifications` again refreshes an expired subscription and
atomically replaces the selected criteria for the same installation.

The service worker validates the push envelope and displays its static
presentation:

```ts
import { showMdbasePushNotification } from "@mdbase/connect";

self.addEventListener("push", (event) => {
  event.waitUntil(
    showMdbasePushNotification(self.registration, event.data?.json())
  );
});
```

Call `connect.unregisterNotifications(worker)` when the user disables browser
notifications. Connect removes the server channel before unsubscribing the
browser, so a transient server error can be retried without orphaning a live
channel.

## Connect-managed native delivery

Use `managed_fcm` when the application owner accepts Connect as part of the
push-delivery trust boundary. Configure one Firebase project for the
application, put its public project ID in the manifest, and grant Connect's
sender identity permission to send messages to that project. The app obtains
an FCM registration token and registers it after a user explicitly opts in:

```ts
await connection.registerNativeNotifications({
  token: await nativeMessaging.getToken(),
  criteria: ["task.reminder"]
});
```

Call the method again when Firebase rotates the token. When the user opts out,
call `connect.unregisterNativeNotifications()` before deleting the local FCM
token.

FCM is the common delivery API on both platforms: Firebase maps the token to
Android delivery directly and to APNs for the iOS build. The native application
still needs its Firebase Android and iOS configuration, notification
permission handling, an Android channel named `mdbase-updates`, and the APNs
key uploaded to Firebase.

Managed delivery is convenient for a personal or single-owner application, but
it has a real security consequence: the Connect sender identity can send a
notification to installations in every Firebase project that grants it send
permission. Connect cannot read application data through that permission and
does not store the application's APNs key, but compromise or misuse of the
sender could produce misleading notifications. Use a dedicated Firebase
project per environment, grant only `cloudmessaging.messages.create`, keep
staging and production separate, and revoke the grant if the integration is no
longer used.

FCM registration tokens and Web Push endpoint/key material are sensitive
routing identifiers rather than sender credentials. Connect stores them in its
control-plane database so delivery survives restarts. Restrict access to that
database and its backups; disclosure could enable delivery targeting or spam,
but does not grant access to collection records.

For an application distributed to a broader audience, prefer the signed
webhook mode below. It keeps Firebase and Apple credentials entirely in the
developer's infrastructure.

## Developer webhook delivery

Declare one HTTPS endpoint:

```json
{
  "notifications": {
    "criteria": [{
      "id": "task.changed",
      "event": {
        "id": "mdbase.record.modified",
        "version": 1
      },
      "presentation": {
        "title": "Tasks changed"
      }
    }],
    "native_delivery": {
      "mode": "webhook",
      "url": "https://api.tasks.example/webhooks/mdbase"
    }
  }
}
```

Connect creates one durable webhook delivery for each matched signal; no
device channel is registered with Connect. The body contains the opaque
connection ID and notification wake-up hint only:

```json
{
  "type": "mdbase.notification.webhook",
  "version": 1,
  "delivery_id": "019...",
  "connection_id": "019...",
  "notification": {
    "type": "mdbase.notification",
    "version": 1,
    "signal_id": "019...",
    "criterion_id": "task.changed",
    "cursor": "42",
    "presentation": {
      "title": "Tasks changed",
      "body": "Open Worklog to see the latest changes.",
      "tag": "task-changes"
    }
  }
}
```

Verify the signature over the exact raw request body before parsing or
enqueueing work:

```ts
import { verifyNotificationWebhook } from "@mdbase/connect-webhooks";

const event = verifyNotificationWebhook({
  body: rawRequestBody,
  headers: request.headers,
  keys: cachedConnectSigningKeys
});

if (await deliveries.claim(event.delivery_id)) {
  await sendThroughYourInfrastructure(event.connection_id, event.notification);
}
```

Fetch and cache keys from
`GET /v1/notifications/webhook-signing-keys`. The SDK checks Ed25519
signatures, the signed delivery ID, and a five-minute replay window. Persist
`delivery_id` before doing work: Connect treats any 2xx response as success and
otherwise retries with leases and exponential backoff. A `Retry-After` header
is respected for retryable responses.

Webhook URLs must use HTTPS. Connect blocks credentials, redirects, loopback,
link-local, private, and otherwise non-public DNS results to prevent server-side
request forgery. Do not use the webhook as record data or authorization proof;
read current state through the ordinary authorized collection API.

## Payload and recovery model

All delivery modes contain only `signal_id`, `criterion_id`, an opaque
authority cursor, and static presentation. The webhook additionally includes
opaque `delivery_id` and `connection_id` values so a developer service can
deduplicate and route work. Treat every notification as a wake-up hint: after
opening, query the collection through the ordinary authorized API. The
underlying record may no longer match.

The authority journals the triggering event and runtime run atomically. Action
invocation IDs become signal IDs, making retries idempotent. Connect uses
durable delivery rows, leases, bounded exponential backoff, and permanent
endpoint disabling. Revoking a grant disables both evaluation and delivery.
Registering a changed declaration creates a new exact application version and
never broadens or rewrites an existing grant.

## Control-plane deployment

Enable only the transports the deployment needs.

Web Push requires one stable VAPID keypair:

```text
MDBASE_CONNECT_VAPID_SUBJECT=mailto:ops@example.com
MDBASE_CONNECT_VAPID_PUBLIC_KEY=...
MDBASE_CONNECT_VAPID_PRIVATE_KEY=...
```

Managed FCM uses Google Application Default Credentials, or an explicit JSON
service-account credential:

```text
MDBASE_CONNECT_FCM_ENABLED=1
MDBASE_CONNECT_FCM_CREDENTIALS_JSON={"type":"service_account",...}
```

Prefer workload identity/ADC where the host supports it. The sender identity
needs only `cloudmessaging.messages.create` on each opted-in application
project.

Signed webhooks require a stable Ed25519 private key and key ID:

```text
MDBASE_CONNECT_WEBHOOK_SIGNING_KEY_ID=connect-2026-07
MDBASE_CONNECT_WEBHOOK_SIGNING_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----...
MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON=[{"kty":"OKP",...}]
```

During rotation, publish the old public JWK through
`MDBASE_CONNECT_WEBHOOK_PREVIOUS_PUBLIC_KEYS_JSON` while deliveries signed by
it might still be in flight. The hosted provider also requires
`MDBASE_CONNECT_CONTROL_PLANE_URL` and the existing internal provider
credential. `MDBASE_CONNECT_HOSTED_NOTIFICATION_INTERVAL_SECONDS` controls
durable source-outbox recovery and defaults to five seconds.
