# ADR 0014: Real-time record collaboration is deferred to a relay design

- Status: deferred
- Date: 2026-09-25

## Context

Collection sharing lets several people and applications edit one hosted
collection. Conventional conditional writes serialize their edits: a stale save
conflicts, and the Editor does not observe a remote change until it rereads the
record.

A development branch (`feature/realtime-collaboration`, August 2026) prototyped
live co-editing of a note body with Yjs in the browser and Yrs in the hosted
provider. It reached a kill-switched LAB Editor with roughly 15,000 lines of
non-test code and 10,000 lines of tests, and was shelved without merging. Its
foundations were sound, but three properties made it costly and unpleasant to
use:

- **Every coalesced update was an authoritative record write.** Each update,
  sent about every 40 ms while typing, locked the collection row and committed a
  record revision, a collection change, and a runtime outbox row. One typist
  serialized all writes in the collection and flooded the change feed consumed
  by mirrors, sync clients, watchers, and notifications.
- **Conventional body writes retired the room.** An ordinary write advanced the
  record's collaboration epoch and deleted the room. Clients pinned to the old
  epoch became terminally unavailable and dropped unacknowledged edits held only
  in memory. Agents, MCP, and sync clients write note bodies routinely, so this
  was a common path rather than an edge case.
- **Presence was too constrained to be useful.** Selections were absolute
  offsets rather than Yjs relative positions, so remote cursors were frozen
  while local updates were pending. Participants were named `Participant N`,
  and presence was scoped to one provider instance.

Most of the branch's complexity followed from treating each Yjs update as a
conventional mutation: client mutation identifiers, durable receipts, a
one-in-flight acknowledgement queue, per-batch reauthorization and credential
fingerprint checks, and epoch fences. Yjs updates are idempotent and
commutative, so state-vector exchange on reconnect already provides most of what
that machinery guarantees.

Simultaneous typing in one note is expected to be rare. The common case is a
person or agent changing a note that someone else has open, which conventional
editing can handle with in-place refresh, three-way body merges on conflict, and
coarse "who is editing" presence.

## Decision

Real-time co-editing is not built now. Conventional editing improvements come
first. If collaboration is revisited, it uses the relay design below instead of
the shelved branch's per-update mutation design.

### Invariants retained from the prototype

- The public record remains ordinary Markdown. Yjs is an implementation profile
  (`markdown-body-yjs-v13`, one root `Y.Text("body")`), never a record format.
- Only the body is collaborative. Frontmatter, path, files, rename, and delete
  stay on the conventional write path.
- Materialization is exact: `UTF8(Y.Text("body").toString())` equals the record
  body bytes, with no normalization or Editor heading projection. Profile v1
  admits LF line endings only.
- A provider-neutral core crate owns profile validation, Yrs state and updates,
  and provider-origin textual deltas (`apply_provider_body`). It owns no SQL,
  encryption, authorization, or transport.
- Yjs and Yrs are pinned exactly, with committed cross-runtime binary fixtures.
- Yjs is lazy-loaded and absent from the ordinary SDK and Editor bundles.

### Relay design

1. **Relay with an append-only log.** One provider process holds the Y.Doc for
   an active room. Accepted updates are appended to an encrypted per-room log
   and relayed to other sessions. Appending takes no collection lock and creates
   no record revision, change, or outbox row.
2. **Deferred materialization.** The room writes its body to the record through
   the ordinary exact-document write path after a short idle period, and when
   the room closes. The change feed observes one revision per pause, not one per
   keystroke. The log is compacted into a snapshot after materialization.
3. **Conventional writes merge into the room.** When an ordinary write changes
   the body of a record with an active room, the provider applies it with
   `apply_provider_body` as a provider-origin update. Rooms are not retired for
   ordinary writes. Epochs advance only for repair, authority transfer, or an
   incompatible profile change.
4. **Sync by state vector, without mutation receipts.** Reconnect exchanges
   state vectors in both directions. Clients persist their Y.Doc locally, for
   example with `y-indexeddb`, so unsent edits survive a closed tab. Duplicate
   or reordered updates are harmless.
5. **Authorize at connection, revoke by closing.** A ticket is authorized when
   the socket connects. Revocation, rotation, and policy changes close affected
   sockets. Updates are not individually reauthorized.
6. **Standard awareness with limits.** The provider relays y-protocols awareness
   using relative positions, with size and rate limits. Display names come from
   the control plane's account profile.

Room routing across provider instances is part of the design work when this is
revisited. Durable correctness must not depend on it, because the log and state
vectors recover any missed relay.

## Revisit when

- measurements after sharing show people frequently editing the same note at
  the same time;
- conventional three-way merges produce overlapping-line conflicts often enough
  to be a user complaint; or
- live agent editing of an open note becomes a product goal.

## Consequences

- Shared collections use conventional editing, improved with in-place refresh,
  automatic body merges, and coarse presence. Those improvements remain useful
  under the relay design.
- The shelved branch is reference material only. Its core crate, Yjs/Yrs
  fixtures, and Editor binding approach may be reused; its per-update commit
  path, receipt and acknowledgement machinery, epoch retirement on ordinary
  writes, and sanitized offset presence are not.
