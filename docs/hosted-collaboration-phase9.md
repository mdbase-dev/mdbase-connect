# Hosted collaboration Phase 9: private client foundation

Phase 9 introduces a shared browser room client for Editor validation without
freezing or advertising a public SDK contract.

## Boundaries

- `@mdbase-dev/connect` keeps its reviewed root, `/advanced`, `/crypto`, packed,
  and browser exports unchanged.
- A versioned, non-enumerable internal symbol bridge issues signed hosted
  collaboration tickets from the current authorization. It never returns
  bearer credentials, proof material, key handles, or transport internals.
- `@mdbase-dev/connect-collaboration` remains a private, lazy-loadable workspace
  package and is the only browser owner of Yjs/WebSocket protocol logic.
- Editor code may receive `Y.Text("body")`, immutable room snapshots, semantic
  awareness setters, `flush()`, and lifecycle methods. It must not encode
  collaboration frames, issue tickets, manage mutation IDs, or implement
  reconnect.

The symbol bridge is not a security boundary. Ticket creation and consumption
remain protected by exact hosted capability, full-collection scope, ordinary
read/update authority, current grant-key leases, request proof, bearer token,
browser Origin, one-shot ticket state, room epoch, and periodic provider
reauthorization.

## Room behavior

Every connection and reconnect obtains a new one-shot ticket. Reconnects bind
ticket creation to the room epoch learned from the first successful ticket, so
old local Yjs state is never silently merged after an epoch transition.

The private room client:

1. authenticates with the exact mdbase binary frame;
2. validates Hello, negotiated update bounds, and provider-instance awareness;
3. sends a Yjs state vector and applies the provider diff with a private remote
   origin;
4. queues local updates in bounded memory with stable mutation UUIDs;
5. sends one update at a time and retains it until the exact durable Ack;
6. replays unacknowledged bytes only after reconnect synchronization;
7. replaces sanitized awareness snapshots wholesale and refreshes awareness
   before the advertised TTL;
8. heartbeats connected sessions and bounds pre-Hello retries and handshake
   stalls; and
9. fails closed on policy loss, malformed frames, wrong epoch/profile, invalid
   roots/bodies, or resource limits.

There is no browser-persistent collaboration queue in this phase. `flush()` and
`pendingUpdates` let the LAB Editor block unsafe note, file, creation, surface,
and collection transitions; terminal or closed rooms reject pending flushes.

## LAB Editor adapter

The experimental Editor build opens one room for the active hosted note and
lazy-loads the Yjs CodeMirror binding only after durable synchronization. The
exact authority-visible Markdown body, including a heading-backed title, comes
from `Y.Text("body")`; React value reconciliation and conventional CodeMirror
history are disabled while that binding owns the editor. The room-owned undo
manager handles local undo and awareness carries only bounded selections.

The note surface starts read-only and becomes writable only for a connected
`read_write` room. It returns to read-only while reconnecting, after policy
loss, and during conventional record operations. Read-only task controls,
attachments, properties, rename, and delete are also gated. Exact Source
editing is unavailable while a room owns the body.

Room snapshots update the Editor projection without making the conventional
note autosave dirty. Before a body-preserving frontmatter patch, rename, or
delete, the Editor flushes durable room updates and rereads the record to obtain
the post-collaboration revision used by the conventional CAS mutation.
Frontmatter replacement patches include top-level deletion tombstones; new
unrepresentable top-level null values fail rather than being deleted silently.

## Kill switches and rollout

The provider remains independently disabled by default with
`MDBASE_CONNECT_HOSTED_COLLABORATION_ENABLED=false` and does not advertise
collaboration readiness.

Editor integration must use a separate, explicit build-time LAB flag. The
ordinary Editor manifest and bundle must remain collaboration-free. Because the
current capability v2 request uses `collection_kind: "hosted"`, the first live
Editor experiment must use a separate LAB build/origin rather than changing the
canonical Editor manifest.

Migration 0045 sanitizes names stored by the preceding private awareness build
and tightens the generic `Participant` invariant. Apply it only while
collaboration admission is fenced and after the control plane emits generic
identities.

## Remaining acceptance gates

- run two-page Chromium and LAB tests for convergence, reconnect, provider
  restart, revocation, awareness, navigation flush, and default-off behavior;
- collect operational metrics, retention, and rollout evidence; and
- validate the API through Editor use for several weeks before considering a
  stable public SDK export.
