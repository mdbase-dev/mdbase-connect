# SDK sync status

`snapshot.sync` is the one status an app shows for the open collection. It is
null until the collection is ready. An app shows `sync.state` and does not
combine the replica's status, the write ledger, transport health and
`navigator.onLine` itself.

```ts
const { sync } = mdbase.getSnapshot();
if (!sync) return null;
switch (sync.state) {
  case "attention":       return <NeedsAttention reasons={sync.attention} />;
  case "saved_on_device": return "Saved on this device";
  case "offline":         return "Offline";
  case "reconnecting":    return "Reconnecting…";
  case "saving":          return sync.pendingFor === "moment" ? "Saved" : "Saving…";
  case "catching_up":     return "Catching up…";
  case "saved":           return "Saved";
}
```

## `state`

The first of these that applies:

| `state` | Meaning |
| --- | --- |
| `attention` | Something needs the person. `sync.attention` lists what, most pressing first. |
| `saved_on_device` | Changes are pending and cannot be delivered now: no network, or the last request to the service failed. They sync when it can be reached. |
| `offline` | This device has no network and nothing is pending. |
| `reconnecting` | The network is there but the service is not answering, or the replica is still connecting. |
| `saving` | Changes are pending and on their way. |
| `catching_up` | Other devices' changes are still arriving. |
| `saved` | Everything made here is confirmed. |

`state` is never `saved` while a change is pending, so it is safe to gate
"close without losing work" on it. To avoid a flicker on every keystroke, read
`pendingFor`.

## The parts

- `connection`: `online`, `reconnecting`, `offline`, or `local` for a
  collection with no cloud copy. `offline` means the device: the browser says
  so (`navigator.onLine === false`, followed through the `online` and `offline`
  events), a request failed with no network, or the replica reports it. An
  unreachable, busy or rate-limited service is `reconnecting`, with the reason
  in `health`.
- `pending`: changes not confirmed yet, counted from the replica and the write
  ledger, whichever knows of more.
- `pendingFor`: `moment` for the first two seconds changes have been pending
  without a break, then `while`, then `long` after thirty seconds. The SDK
  notifies subscribers at both steps, so an app keeps no timer.
- `writes`: the write ledger's snapshot, with each pending and rejected write.
  It survives a reload. `mdbase.getSnapshot().writes` is removed.
- `attention`: any of a refusal by the service (`collection_not_yet_migrated`,
  `collection_migrating`, `update_required`, `account_suspended`), `rejected`
  (see `writes.rejected`), `conflicts`, `held`, `incident` (see `incidents`),
  and `storage_may_be_evicted`.
- `conflicts`, `holds`, `incidents`: the replica's counts and incident list.
- `live`: false while other devices' changes are not arriving live. It does
  not change `connection`: writes still go through.

## Without the application entry

A host that holds only a client (a desktop shell, a plugin) calls the same
function:

```ts
import { summarizeSync } from "@mdbase-dev/sdk";

const sync = summarizeSync({
  status: client.status,
  writes: client.ledger.getSnapshot(),
  link: client.link,
});
```

Subscribe to `client.onStatus`, `client.ledger.subscribe` and `client.onLink`
to know when to call it again. `pendingForMs`, `online`, `transport`, `live`,
`problem` and `storageWarning` are optional; without `pendingForMs` a pending
change reads as `while`.

## Migration

- `summarizeStatus(status, problem, transport, live)` becomes
  `summarizeSync({ status, problem, transport, live })`.
- `StatusSummary.kind`: `synced` is `state: "saved"`; `local` is
  `connection: "local"`; `catching_up` and `installing` are
  `state: "catching_up"`; a refusal is in `attention`.
- `kind === "offline"` meant no network or a service that did not answer. That
  is exactly `sync.connection === "offline" || sync.health === "unreachable"`.
  `connection === "reconnecting"` is wider: it also covers a busy or
  rate-limited service, a replica that is still connecting, and a closed link.
  An app that showed "Offline" for the old kind and wants the same moments
  uses the expression above, not `connection !== "online"`.
- A first download no longer has its own kind. An app that words it
  differently from catching up reads `client.status.installing`, which is set
  (with `done` and `total`) while the collection is first loaded.
- `StatusSummary.text` is removed. The words are the app's: choose them from
  `sync.state`. For a refusal by the service, `phase.problem` has the title and
  message.
- `snapshot.writes` is `snapshot.sync.writes`.
- `snapshot.saveWarning` still exists for app-ui's `CollectionSaveWarning` and
  goes once that reads `sync.attention`.
