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
`pendingUpdates` let the future Editor block unsafe navigation; terminal or
closed rooms reject pending flushes.

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

- integrate the private room into the Editor behind the LAB-only build flag;
- make the complete authoritative Markdown body, including heading title,
  CodeMirror's collaborative source;
- disable conventional body autosave and body-affecting controls while a room
  owns the body;
- lazy-load Yjs/CodeMirror collaboration chunks only after admission;
- run two-page Chromium and LAB tests for convergence, reconnect, provider
  restart, revocation, awareness, navigation flush, and default-off behavior;
- collect operational metrics, retention, and rollout evidence; and
- validate the API through Editor use for several weeks before considering a
  stable public SDK export.
