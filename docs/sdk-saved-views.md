# SDK: saved-view sources

`db.views.createSource({id, path, document, type?}, {mutationId, ...writeOptions})`
creates the exact caller-supplied source. Capture and retain the record UUID and
mutation UUID before submitting (the SDK exports `uuidv7`). No renderer, record
type, filename extension or YAML is inferred or rewritten.

`db.views.getSourceRecord(ref, {include?, signal?})` requests a complete native
record with its document included. `db.views.updateSource(seen, document,
{mutationId, ...writeOptions})` uses that genuine `RecordView`'s UUID, path, full
source and revision for whole-document CAS. Pending revisions are valid; held,
unresolved, metadata-only or inconsistent source witnesses refuse. A new edit
needs its own captured mutation UUID, not a replacement for an unknown outcome.

Both write helpers return the original SDK `Write`, force document-inclusive
readback, and preserve receipt IDs, confirmation and publication separately.
Neither performs an implicit refresh or prepares/resubmits on unknown outcomes.
The ordinary client transport's same-mutation retry policy is unchanged.

For **web app-host** saved-view discovery/execution/exact source reads, use
`listAppBasesViews`, `executeAppBases` and `readAppBasesViewSource`, with the types
from `@mdbase-dev/sdk/app-host`. Keep native UUID/SHA/original ordinal and actual
source options. The generic `views.list/execute/readSource` RPC surface is not an
app-host fallback; unavailable capabilities remain explicit refusals.

Pass `reportUnreadable: true` to `listAppBasesViews` so one malformed record
cannot hide every view. A replica that grants `bases-discovery-unreadable-v1`
then skips each record it cannot classify (malformed YAML, a `views` value that
is not a list of views, a record whose types do not resolve) and names it in the
page's `unreadable` list: `record`, `path`, `sourceRevision`, `reason` (the
refusal reason request version 1 returns, such as `view_metadata_unavailable` or
`view_unsupported_construct`) and `detail` (such as
`base_raw_frontmatter_unavailable`). A page names at most 32; keep following the
continuation. A replica without the feature refuses the discovery as before, so
an empty `unreadable` on a successful page means nothing was skipped. Budget,
cancellation and catalog failures still refuse the whole discovery.

To read a whole saved view in pages, iterate `executeAppBasesPages(request,
{firstPageSize?, pageSize?, signal?})` (defaults 200 then 1000 rows; at most
65536). Each page is one independent windowed read with `page`, `offset`,
`loaded` and `complete`. Native reads have no cross-request cursor or snapshot,
so `changedSinceFirst` marks pages read after the collection revision or matched
row count changed; rows may then be skipped or repeated, and callers that need a
coherent set restart. A native refusal is yielded once and ends the iteration.
