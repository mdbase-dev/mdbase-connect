# SDK: opening a cloud copy

## Cloud-copy first-open waits

Initial opening keeps the same enrolled device, native host, SQL and keys while
retrying a parsed CP HTTP 503 `busy` log-token refusal. There are at most three
log-init attempts; retries must fit a 15-second scheduling window and respect
Retry-After. Individual challenge/mint requests retain their 15-second deadlines.
Unknown 401/403/409 responses, malformed responses and generic unavailable errors
do not authorize a retry. Each failed mint retry obtains a fresh challenge/proof,
not another enrollment or collection.

For a previously synced local replica, the native verified-read gate keeps its
15-second deadline, including connect, pump and Query. For a cold replica (the
SDK join ledger has never recorded a completed first sync), the same 15 seconds
bounds **lack of progress**, not total catch-up time. The watchdog observes native
accepted prefix, advancing data/control READ cursors and snapshot-install
positions even while a multi-RPC pump is pending. Control READ cursors cover
key scanning whose native `reading` incident does not expose intermediate
positions. Only native-accepted replies to increasing cursors count; sending
calls, rejected replies, head growth, heartbeats and repeated cursors do not
reset it. Active, size/range-capped response bytes can defer a stall for the
already in-flight calls under their existing per-request deadlines; they do not
reset native progress or admit READ. Once those calls settle, successive retries
cannot renew that deferral without accepted native progress. This also covers
object downloads whose existing per-request budget exceeds 15 seconds.
Cold catch-up must reach the complete known prefix,
then pass an actual native Query; metadata never admits a data facade. A stall
fails typed `AppCloudCopyHostError("sync_stalled")` (the existing public
`unavailable` problem with a distinct diagnostic code).

Both paths retain typed READ-unavailable pacing (250 ms, 500 ms, then at most
one per second). Explicit server authority outcomes and typed HTTP 403
`forbidden` are latched against concurrent success. An HTTP status alone is not
terminal: stale-token 401 can invalidate/refresh through the existing authority,
and opaque routing/timeouts keep the existing NoResponse path. Native Query
`unauthenticated`/`forbidden` errors still refuse without retry. Cancellation stops the waits;
failed keyring recovery and non-retryable native errors still refuse. This remains the existing opening
state, with explicit retry after a terminal failure: no new migration state,
write/setup replay, legacy fallback or application retry loop is needed.

## Reopening a cloud copy from this device

A cloud copy whose join ledger records a completed first sync opens from the
replica on this device before the log is reached. The log-token request starts
in the background, a verified read is answered by the replica as it stands, and
the collection is handed to the app. The first drive turn then binds the log,
sends edits captured meanwhile and brings in what changed elsewhere. What the
app shows first is therefore the collection as of this device's last sync, and
it updates when the first turn lands. Saved views read in that window as well:
the replica serves them while it re-derives its keys from the log.

The ledger and the replica are stored separately. A replica that holds nothing
from the log (`holdsLog()` is false: its storage was lost after that sync) is
not opened this way. It binds the log first and catches up like a first open.

A bind that fails is sorted once:

- offline, unreachable, 5xx and 429 leave the collection open with `health`
  set, and the drive loop retries with its usual backoff and on foreground. A
  reply that is not Connect's, such as the sign-in page of a network the device
  has just joined, counts as unreachable;
- a server outcome with its own copy (migrating, suspended, update required,
  not yet migrated) shows as the connection's `problem` and is retried slowly;
- any other answer from Connect (401/403, other 4xx) sets the connection's
  `failure`. The sign-in session then blocks the collection with the same
  problem a failed open reports and closes it. It reads `failure` when the open
  returns as well as on later changes, so a refusal that arrived before the
  handoff never shows as ready.

Once bound, the replica checks its stored policy against the log while it
re-derives its keys. A replica that fails that check sets `failure` with
`recovery_required`, which is what a waited open refuses it with.

An edit made before the bind is an offline edit and is treated as one: kept
pending and sent once the log is bound. Nothing here changes what the log does
with an edit from a device whose access was removed while the app was closed.
A log token is valid for up to 16 minutes, so such a device can still bind
with a token it kept; refusing its entries is the log's job, as it was before.

The local read has five seconds. If the replica cannot answer it, the open
takes the ordinary path above. Private collections and cold replicas always
take that path.

A signed-in start likewise publishes the collection list this installation kept
from its last listing, with no request. That list carries no file actions and a
collection missing from it is not treated as removed. The Worker host then reads
Connect's list: straight after a start that already holds a collection,
otherwise after the page's next request, or after two seconds. A read that did
not happen (the session was busy, or the request failed) is tried again two
seconds later, three times in all; after that the next show or reconnect reads
it. `collectionListCached()` on the session says which list is showing.
