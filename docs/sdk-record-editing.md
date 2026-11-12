# SDK: record editor leases

```ts
const lease = await db.records.open({path: "notes/writing.md"}, {
  autosave: {idleMs: 500}, // omitted/false means explicit flush only
  signal,
});
const stop = lease.session.subscribe(() => render(lease.session.getSnapshot()));
lease.session.setBody(editedBody);
lease.session.patchFrontmatter({title: "New title"}); // undefined unsets a key
const result = await lease.session.flush({timeoutMs: 30_000, signal});
if (!result.ok) showProblem(result.problem);
stop();
lease.release();
```

UUIDs and `{path}` selectors use ordinary native `get`/`update` operations. Full
native document/body/revision and current protection gates are required; edits
use the actual source's whole-document CAS, field observations and body base.
There is no source reconstruction, replacement record UUID or new app database.
`records.open` throws SDK errors; `flush` returns `{ok, record}` or `{ok, problem}`.
Snapshots hold the plain `frontmatter` with unsaved changes applied, native `record`/`remote`, draft `body`,
`dirty`, `problem`, and the original `recovery` mutation identity/receipt/`Write`.
Saved requires actual confirmed, unprotected, same-UUID full native readback;
receipt confirmation alone (or optimistic/pending readback) is insufficient.

Submission is serialized per UUID/client. A mutation ID is exposed through the
snapshot **before** submission. Ambiguous submit/readback failures keep that ID;
subsequent flush only awaits its actual receipt, never resubmits or substitutes
another mutation. New edits made during capture remain drafts for a subsequent
intent only after the first has genuinely settled. A unique pending operation
from this client's native pending API can recover an editor session; foreign or
ambiguous pending ownership refuses. Across client lifetime/reload, retain the
snapshot's `RecordRecoveryRef` (`mutationId`, `recordId`, `baseRevision`) in the
caller-owned recovery state and pass it as `open(..., {recovery})`, particularly
when the receipt settled but readback failed. The helper adds no durable journal
and does not infer ownership from a shared current pending record.

Active leases share the UUID's draft/session and must agree on autosave/timeout
policy. Releasing/aborting one lease unsubscribes it without closing the client
or evicting another lease. Last release stops autosave/observation and aborts
late delivery, retaining unsaved/recovering data for reopen on the same client.
Client close suspends all leases. Retention is bounded to 64 sessions and 8 MiB
of serialized retained-data accounting; budget refusal never evicts drafts.
This accounting is not a measured peak-heap claim.

For a settled CAS conflict, `resolve({keep: "mine" | "theirs"})` or
`resolve({body})` explicitly rebases on a genuine confirmed/unprotected remote
readback. Native held/unresolved records remain refused: the current native
hold-resolution producer lacks caller-captured mutation identity and cancellation,
so this helper cannot safely resolve a hold or retry its unknown outcome. It does
not use a fresh `resolveHold` call as a workaround. Change notifications hydrate
the same UUID; observer failure is exposed, not treated as a successful refresh.

## Writer lease mapping

Writer's editor leases are local references to a shared draft/session, not
server-issued exclusive editing locks. Its existing lease contract maps to the
public SDK without a new lease RPC:

| Writer use | Public SDK operation |
| --- | --- |
| Open/follow a manuscript or embedded record | `records.open(ref, {autosave, timeoutMs, signal})`, session `subscribe` / `getSnapshot` |
| Edit body or staged frontmatter | Session `setBody` / `patchFrontmatter` |
| Autosave or explicit bounded save | Session `flush`; actual revision CAS and original mutation/receipt recovery |
| Show saved/conflict/recovery/deleted state | Genuine session snapshot; confirmed receipt plus full confirmed/unprotected same-UUID readback for saved |
| Choose a settled CAS conflict result | Session `resolve`; native held/unresolved records remain refused |
| Recover across client lifetimes (caller retains witness) | Retained `RecordRecoveryRef` passed to `records.open`; never a replacement mutation |
| Close an editor | Unsubscribe and `lease.release`; local lifetime release, not a remote unlock or save acknowledgment |

Sharing is per UUID/client, not across devices or independent clients. Revision
CAS protects save attempts; it does not exclude another editor. Writer's lease
flow does not need presence. The current native Replica presence RPCs return
`not_yet("presence")`, even though its hello can admit the `presence` marker;
negotiation alone is not a live presence implementation or write authority.
This mapping does not qualify Writer's native UI/runtime integration.
