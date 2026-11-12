# SDK: feature negotiation and operation mapping

Use the existing `connect({ features: [...] })` / `client.hello.features` surfaces.
Keep the exact factory-owned request list, not a later-mutated options array:

```ts
const requestedFeatures = Object.freeze(["presence"]);
const client = await connect({ connector, app, features: [...requestedFeatures], signal });
function negotiatedMarker(name: string) {
  // Access the current hello; session errors propagate, never become false.
  const granted = client.hello.features;
  if (!requestedFeatures.includes(name)) return "not_requested";
  return granted.includes(name) ? "negotiated" : "not_negotiated";
}
```

While the initial hello is pending, a requested marker is **requested / pending**,
not unsupported. A successful hello grants only the requested-supported
intersection, not a complete catalog. An absent *unrequested* marker is not
negative evidence. Failed negotiation, no current session, connection/refusal
errors or cancellation stay errors; do not substitute `false` or a stale hello
from another session. No new probe or feature-discovery RPC is needed.

The current native Replica source admits `presence`, bare `attachment-v1` codec
support, and qualified `attachment-v1.read` / `attachment-v1.materialize`
directions where that replica supports them. Bare codec support does not grant a
direction; this producer does not grant `attachment-v1.write`. This is a source
inventory, not deployed runtime/transport/app acceptance. A testing replica's
advertised markers are not a native capability certificate.

Legacy Connect labels are not native feature names or negotiation aliases:

| Legacy probe | Public SDK mapping | What it does **not** prove |
|---|---|---|
| `query-metadata-v1` (Reader and Writer discovery) | `query` / `queryPages` with canonical Core `select` and explicit Include; typed `QueryResult` / `RecordView.values`, columns and page metadata | No legacy `output: metadata` mode, metadata-only SQL/performance guarantee or native feature marker |
| `read-many-documents-v1` (Reader hydration) | `readMany(refs, { include, signal })`; ordinary bounded `get` calls | No native bulk opcode, transaction or same-snapshot / shared-`asOf` proof |
| `query-record-revisions-v1` (legacy performance fixtures, not a Reader/Writer product probe) | Genuine mandatory `RecordView.id`, `.path` and `.revision` | No confirmed save, currentness after delivery, full edit base or draft/CAS authorization |

Writer's legacy changed-path `readMany` call has no bulk-feature probe. The next
Reader/Writer adapters do not require legacy feature probes: use their public
SDK operations and preserve actual errors. These mappings do not add an
app-specific engine, legacy protocol fallback, automatic query reset or new
permissions.

For discovery without bodies/documents, use explicit `{ body: false, document:
false }` Include and the intended canonical query selection. Retain whole pages,
`complete`, `asOf`, diagnostics and opaque cursors; unsupported semantics or
insufficient native budgets refuse, not approximate or empty success. Discovery
and hydration can observe different cuts: recheck actual ID, provider/source and
revision witnesses rather than treating multiple gets as one snapshot.

`client.hello.grant.capabilities` and role are hello-time permission snapshots,
**not current authorization or feature support**. READ uses `collection.read`;
ordinary native RPC reauthorization remains authoritative. `describe()` inspects
catalog/types/contracts, not a feature catalog. Neither a successful grant nor a
negotiated marker overrides a later native refusal. Keep the original signal and
problem; do not turn errors into negative capabilities or fabricated diagnostics.
