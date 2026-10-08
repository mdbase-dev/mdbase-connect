# CP nil-registry transport and denial union

This extends the permanent denial ledger from #664. Existing `LogServiceClient` owns the authenticated configured HTTPS/PoP transport; `collection-deletion.ts` owns the fixed three-field DTO and page transactions. No parallel transport or storage mechanism is introduced.

## Frozen native registry contract

`recordCollectionDeletion` sends exact `{0:nilUUID16,1:collectionUUID16,2:deletionUUID16,3:positive_epoch_u64}`. Successful result is exactly `{0:1,1:collectionUUID16,2:deletionUUID16,3:epoch_u64,4:generation_u64}`. All identity/epoch fields must match the request. A bool or mismatched typed receipt refuses. A typed conflict remains an error; existing error details are retained for later authoritative reconciliation, not silently merged as success.

`registryCollectionDeletions` sends `{0:nilUUID16,1:afterUUID16_or_null,2:expected_generation_u64_or_null}`. Explicit canonical CBOR null uses the existing encoder. Result is exactly `{0:1,1:generation_u64,2:[[collectionUUID16,deletionUUID16,epoch_u64],...],3:lastUUID16_or_null,4:done_bool}`. Positive full-width epochs and zero-or-positive full-width generations become bigint; unsafe numbers refuse. UUIDs are exact16-byte nonnil values and become canonical lowercase36-character strings.

Pages contain at most128 strictly ascending collections after the supplied cursor. The returned cursor equals the last row, or retains the supplied cursor on an empty terminal page. Exactly128 rows requires another page. A nonnull cursor requires expected generation; every continuation must match it. No challenge/environment fields or new signer are added to the frozen17:00 wire. Current authenticated non-restored registry is the authority, not a restored CP timestamp/signature.

## Scoped control-reply bounds

Only registry methods use manual redirects, a streamed256-byte nonce bound, a streamed32KiB RPC bound, canonical struct decoding with depth12 and exact response request-ID matching. Overflow cancels before decode. Captured request IDs remain correct under overlapping requests. Other LS methods keep their existing limits/redirect behavior.

The prior JSON control reader delegates byte streaming to the same helper, preserving its null-body/strictUTF8/parse behavior and existing4096-byte caller limits. No unrelated record/file/provider reply receives the new registry limit. Canonical CBOR mode refuses floating/nonminimal integers; the legacy unscoped decoder remains unchanged.

## Durable reconciliation primitive

`reconcileCollectionDeletionFloors` admits the public structural peer's DTO independently: it captures only generation/cursor/done and copies all validated rows before connecting to the database. Generation type/range/pin, canonical nonnil cursor, whole-page bounds/tuples/strict advancement, last-cursor equality and done-count consistency are checked without getter rereads or arbitrary-property passthrough. The final empty confirmation uses the same admission boundary. It commits each validated page into the permanent no-FK denial union. Earlier local/older/higher/conflicting facts are never erased. After a terminal page commits it issues a final same-generation empty page check using the retained last cursor. Lost/partial/drifting replies throw without returning a completed revision; already committed denials survive and retry remains idempotent. No auto-restart makes failure optimistic. A traversal is bounded to4096 pages (524288 rows); exhaustion remains closed and requires a new caller attempt/operator diagnosis, not partial success.

The returned bigint is an observed complete revision, **not a startup-positive permit or effect-time lease**. This change does not register a startup hook, open keys/import/serving, delete a native log, acknowledge Deleted or purge anything. Startup wiring must additionally reconcile every candidate terminal status and existing tuplelessGone denial, and effect-time native floor/Gone/import/aux/final-publication/Hosted fences remain separate. Deleted needs independently matching typed floor AND durable Gone receipts. No legacy bare bool/404/absence shortcut.

## Qualification boundary

Signed mock-peer tests cover nil/cursor/PoP/typed maps, full-u64, malformed/duplicate/order/schema refusals, conflicts, overlapping request IDs, bounds/cancellation/manual redirects and unrelated-reader compatibility. Disposable PostgreSQL tests cover130-row paged union/final check, partial/final drift and retry while retaining denial. These are not real native authority, startup, restore, retirement or activation evidence.
