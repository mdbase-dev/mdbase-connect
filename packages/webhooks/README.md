# `@mdbase/connect-webhooks`

Server-side verification for signed mdbase notification webhooks.

```ts
import { verifyNotificationWebhook } from "@mdbase/connect-webhooks";

const event = verifyNotificationWebhook({
  body: rawRequestBody,
  headers: request.headers,
  keys: cachedConnectSigningKeys
});

if (await deliveries.claim(event.delivery_id)) {
  await sendNativePush(event.connection_id, event.notification);
}
```

Fetch and cache verification keys from
`/v1/notifications/webhook-signing-keys`. Verification requires the exact raw
request body, rejects modified payloads, and enforces a five-minute replay
window. Store `delivery_id` before doing work because Connect retries until the
endpoint returns a successful HTTP response.
