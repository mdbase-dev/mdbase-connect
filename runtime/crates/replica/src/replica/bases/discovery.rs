//! Bounded primary UUID inventory discovery. No type-index shortcut or fallback.
use super::*;
use crate::{api::SessionId, store::Head, store_query::QueryRecordSize};
use mdbn_core::views::bases::IncrementalBasesBudget;
use std::collections::BTreeMap;

/// Identities per metadata read and per hydration call; the local source
/// helpers accept at most 128.
const METADATA_ROWS: u32 = 128;
/// A page's source work is the whole binding 1000-record / 1 MiB profile, under
/// ONE ledger. Every selected source is read once to classify it; only a source
/// that classifies as a Base is read again by the final CAS, and the page
/// reserves that reread before it keeps the Base. Discovery reads every record in
/// the collection, one relayed round trip per page, so its round trips scale
/// with the collection's bytes over this bound (tasknotes-app#436).
const PAGE_ROWS: u32 = 1000;
const PAGE_BYTES: u64 = 1 << 20;
/// The largest source a page may select: half the page, so a Base can always
/// be classified and reread within one page.
const INITIAL_BYTES: u64 = PAGE_BYTES / 2;
const SLOT_BYTES: u64 = 4096;
const MAX_SLOTS: usize = 64;

/// A separate native discovery continuation, never a Query/execution cursor.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct BasesDiscoveryHandle(pub [u8; 32]);
/// One bounded page under a frozen native discovery cut.
pub struct BasesDiscoveryPage {
    /// Exact source identities and original declaration ordinals.
    pub views: Vec<BasesViewDescriptor>,
    /// Native frozen membership clock, shared only within discovery.
    pub clock: OpClock,
    /// Trusted collection revision.
    pub collection_revision: Hash,
    /// Opaque native continuation; None means complete universe exhaustion.
    pub next: Option<BasesDiscoveryHandle>,
}
/// Exact native current source for one proven declaration, not a path alias.
pub struct BasesViewSource {
    /// Native source/ordinal provenance reclassified under this capture.
    pub view: BasesViewDescriptor,
    /// Exact UTF-8 source bytes, including original formatting.
    pub source: String,
    /// Frozen native membership clock for this read only.
    pub clock: OpClock,
    /// Trusted collection revision.
    pub collection_revision: Hash,
}
struct Entry {
    token: BasesDiscoveryHandle,
    fence: BasesReadFence,
    head: Head,
    as_of: u64,
    clock: OpClock,
    after: Option<Uuid>,
    unfinished: Option<(Uuid, Hash, u32)>,
}
/// Fixed resident bound; sessions never share a continuation slot.
#[derive(Default)]
pub(in crate::replica) struct DiscoverySlots {
    entries: BTreeMap<SessionId, Entry>,
}
impl DiscoverySlots {
    pub(in crate::replica) fn remove(&mut self, session: SessionId) {
        self.entries.remove(&session);
    }
}
fn stale_discovery() -> crate::api::ApiError {
    ErrorCode::Conflict.err_with_reason(
        "view_discovery_stale",
        "discovery changed or expired; start fresh discovery",
    )
}
fn budget(detail: &'static str) -> crate::api::ApiError {
    failure(EvaluationFailure::BudgetExceeded(detail))
}
fn source_error(error: crate::store::StoreError) -> crate::api::ApiError {
    match error {
        crate::store::StoreError::Full => budget("bases_discovery_source_reads"),
        _ => unavailable(),
    }
}
impl<S: Store> Replica<S> {
    // Discovery reads primary UUID/size metadata and raw record bytes, not the
    // optional ClockNone typed projection. Its completeness witness is primary
    // universe exhaustion under this applied head and the full BasesReadFence.
    fn discovery_head(&self) -> ApiResult<Head> {
        let head = self.store.head().map_err(|_| unavailable())?;
        if head != self.head {
            return Err(unavailable());
        }
        Ok(head)
    }
    fn recheck_discovery(&self, session: SessionId, entry: &Entry) -> ApiResult<()> {
        self.authorize_bases_read(session)?;
        self.recheck_bases_read_capture(&entry.fence)?;
        if self.view_version != entry.as_of || self.discovery_head()? != entry.head {
            return Err(stale_discovery());
        }
        Ok(())
    }
    fn new_discovery(&mut self, timezone: Option<&str>) -> ApiResult<Entry> {
        let mut fence = self.bases_read_capture_fence()?;
        fence.release_discovery_catalog_pin();
        let head = self.discovery_head()?;
        if !self.bases_read_catalog().is_valid()
            || !self
                .bases_read_catalog()
                .contracts()
                .iter()
                .any(|contract| contract.id == BASES_CONTRACT)
        {
            // Name the missing contract, as indexed execution does; it is not
            // an incomplete inventory and retrying never clears it.
            return Err(ErrorCode::Unavailable.err_with_reason(
                "bases_contract_not_installed",
                "the obsidian.base data contract is not installed and valid",
            ));
        }
        let zone = timezone
            .map(str::to_owned)
            .unwrap_or_else(|| self.host.zones.default_zone());
        if zone.len() > 128 {
            return Err(invalid());
        }
        let instant_ms = self.capture_instant();
        let local_date = self
            .host
            .zones
            .local_date(instant_ms, &zone)
            .ok_or_else(invalid)?;
        let entry = Entry {
            token: BasesDiscoveryHandle([0; 32]),
            fence,
            head,
            as_of: self.view_version,
            clock: OpClock {
                instant_ms,
                tz: zone,
                local_date,
            },
            after: None,
            unfinished: None,
        };
        // Entry/registry slack plus BOTH string allocations and the Weak's
        // retained Catalog inline/control-block allocation are charged here.
        // No catalog-owned maps/resources are retained by a discovery slot.
        let metadata_bytes = (std::mem::size_of::<Entry>() as u64) * 3
            + 128
            + entry.clock.tz.capacity() as u64
            + entry.clock.local_date.capacity() as u64
            + BasesReadFence::discovery_catalog_allocation_bytes();
        if metadata_bytes > SLOT_BYTES {
            return Err(budget("bases_discovery_slot_metadata"));
        }
        Ok(entry)
    }
    /// Read one bounded page and encode INSIDE the original publication fence.
    /// A supplied handle is single-use. Drift/failed consumption requires fresh
    /// discovery, never an implicit new-cut retry. Caller uses zeroizing output.
    pub fn encode_bases_discovery_page<T>(
        &mut self,
        session: SessionId,
        timezone: Option<&str>,
        limit: u32,
        resume: Option<BasesDiscoveryHandle>,
        encode: impl FnOnce(&mut Self, &BasesDiscoveryPage, &mut IncrementalBasesBudget) -> ApiResult<T>,
    ) -> ApiResult<T> {
        self.authorize_bases_read(session)?;
        if limit == 0 || limit > 128 || timezone.is_some_and(|zone| zone.len() > 128) {
            return Err(invalid());
        }
        let mut ledger = IncrementalBasesBudget::new();
        ledger.retain(SLOT_BYTES).map_err(failure)?;
        let mut entry = if let Some(token) = resume {
            if self
                .bases_discovery
                .entries
                .get(&session)
                .is_none_or(|entry| entry.token != token)
            {
                return Err(stale_discovery());
            }
            self.bases_discovery
                .entries
                .remove(&session)
                .ok_or_else(stale_discovery)?
        } else {
            if !self.bases_discovery.entries.contains_key(&session)
                && self.bases_discovery.entries.len() >= MAX_SLOTS
            {
                return Err(budget("bases_discovery_slots"));
            }
            self.new_discovery(timezone)?
        };
        self.recheck_discovery(session, &entry)?;
        if timezone.is_some_and(|zone| zone != entry.clock.tz) {
            return Err(invalid());
        }
        // Select, read and classify the longest identity-ordered prefix that
        // fits the page's source work, one metadata read at a time. Each
        // metadata read is precharged before it runs, each hydration is
        // admitted against what is left after the rereads already reserved,
        // and a Base is kept only when its own reread still fits.
        let mut sources = QueryBudget::new(PAGE_ROWS, PAGE_BYTES);
        let resumed = entry.unfinished;
        let mut selected = 0usize;
        let mut exhausted = false;
        let mut previous = entry.after;
        let mut reread: Vec<(QueryRecordSize, LocalRecord)> = Vec::new();
        let (mut reserved_rows, mut reserved_bytes) = (0u32, 0u64);
        let mut views = Vec::new();
        let mut processed = 0usize;
        let mut stopped = false;
        while !stopped {
            let (steps, cost) = self.bases_local_metadata_cost(METADATA_ROWS)?;
            ledger.retain(cost).map_err(failure)?;
            ledger
                .admit(|work| {
                    if work.charge(steps, cost) {
                        Ok(())
                    } else {
                        Err(work.failure().expect("local discovery metadata"))
                    }
                })
                .map_err(failure)?;
            let chunk = self
                .bases_local_sizes(
                    Page {
                        after: previous,
                        limit: METADATA_ROWS,
                    },
                    entry.head,
                )
                .map_err(|_| unavailable())?;
            if chunk.len() > METADATA_ROWS as usize {
                return Err(invalid());
            }
            let short = chunk.len() < METADATA_ROWS as usize;
            let total = chunk.len();
            let mut admitted = Vec::new();
            let (mut rows_left, mut bytes_left) = (
                sources.records_left().saturating_sub(reserved_rows),
                sources.bytes_left().saturating_sub(reserved_bytes),
            );
            for row in chunk {
                if previous.is_some_and(|id| row.id <= id) {
                    return Err(invalid());
                }
                previous = Some(row.id);
                if rows_left == 0 || row.encoded_bytes > bytes_left {
                    break;
                }
                if selected == 0 && admitted.is_empty() && row.encoded_bytes > INITIAL_BYTES {
                    return Err(budget("bases_discovery_source_bytes"));
                }
                rows_left -= 1;
                bytes_left -= row.encoded_bytes;
                admitted.push(row);
            }
            if selected == 0
                && let Some((id, _, _)) = resumed
                && admitted.first().is_none_or(|row| row.id != id)
            {
                return Err(stale_discovery());
            }
            if selected == 0 && admitted.is_empty() && total > 0 {
                return Err(budget("bases_discovery_source_bytes"));
            }
            // A short metadata read is the universe's end only when the page
            // took all of it. A page that stops on its own bound needs a later
            // page (possibly an empty EOF probe).
            exhausted = short && admitted.len() == total;
            stopped = admitted.len() < total || short;
            if admitted.is_empty() {
                break;
            }
            selected += admitted.len();
            let bytes = admitted.iter().map(|row| row.encoded_bytes).sum::<u64>();
            // The metadata bound and the page's ONE source meter precede hydration.
            ledger
                .retain(bytes + (admitted.len() as u64) * 512)
                .map_err(failure)?;
            let ids: Vec<_> = admitted.iter().map(|row| row.id).collect();
            let rows = self.discovery_hydrate(&ids, entry.head, &mut sources)?;
            if rows.len() != admitted.len() {
                return Err(invalid());
            }
            self.recheck_discovery(session, &entry)?;
            for (row, meta) in rows.into_iter().zip(admitted) {
                self.check_discovery_source(&row, meta.id, meta.encoded_bytes, &mut ledger)?;
                if entry
                    .unfinished
                    .is_some_and(|(id, revision, _)| id != row.id || revision != row.revision)
                {
                    return Err(stale_discovery());
                }
                let (document, footprint) = ledger
                    .admit(|work| {
                        if !work.charge(row.doc.len() as u64, row.doc.len() as u64) {
                            return Err(work.failure().expect("discovery source"));
                        }
                        Document::parse_at_bounded(&row.path, &row.doc)
                            .map_err(|_| EvaluationFailure::BudgetExceeded("base_source_structure"))
                    })
                    .map_err(failure)?;
                ledger
                    .retain(footprint.estimated_heap_bytes)
                    .map_err(failure)?;
                let base = ledger
                    .admit(|work| {
                        if !work.charge(footprint.values, footprint.estimated_heap_bytes) {
                            return Err(work.failure().expect("discovery structure"));
                        }
                        discover_base_record(
                            self.bases_read_catalog(),
                            &row.path,
                            &document,
                            &entry.clock,
                            work,
                        )
                    })
                    .map_err(failure)?;
                let start = entry
                    .unfinished
                    .map_or(0, |(_, _, ordinal)| ordinal as usize);
                let declared = base.as_ref().map_or(0, |base| base.views.len());
                if start > declared || (entry.unfinished.is_some() && start == declared) {
                    return Err(stale_discovery());
                }
                let base_found = base.is_some();
                let mut unfinished = None;
                if let Some(base) = base {
                    // The final CAS rereads this Base. When that reread no
                    // longer fits, the Base starts the next page instead.
                    if sources.records_left() <= reserved_rows
                        || meta.encoded_bytes > sources.bytes_left() - reserved_bytes
                    {
                        if processed == 0 {
                            return Err(budget("bases_discovery_source_bytes"));
                        }
                        stopped = true;
                        exhausted = false;
                        break;
                    }
                    reserved_rows += 1;
                    reserved_bytes += meta.encoded_bytes;
                    let take = (limit as usize - views.len()).min(base.views.len() - start);
                    for view in base.views.iter().skip(start).take(take) {
                        let retained = row.path.len()
                            + view.view_type.len()
                            + view.name.map_or(0, str::len)
                            + base
                                .implementations
                                .iter()
                                .map(|i| i.type_name.len() + 256)
                                .sum::<usize>()
                            + 256;
                        ledger.retain(retained as u64).map_err(failure)?;
                        ledger
                            .admit(|work| {
                                if work.charge(1, retained as u64) {
                                    Ok(())
                                } else {
                                    Err(work.failure().expect("discovery descriptor"))
                                }
                            })
                            .map_err(failure)?;
                        views.push(BasesViewDescriptor {
                            record: row.id,
                            path: row.path.clone(),
                            revision: row.revision,
                            index: view.index,
                            name: view.name.map(str::to_owned),
                            view_type: view.view_type.to_owned(),
                            implementations: base
                                .implementations
                                .iter()
                                .map(|implementation| BasesImplementationDescriptor {
                                    type_name: implementation.type_name.clone(),
                                    version: implementation.version.to_string(),
                                    contract_digest: B32(implementation.contract_digest.0),
                                    implementation_digest: B32(implementation.digest.0),
                                })
                                .collect(),
                        });
                    }
                    if start + take < declared {
                        unfinished = Some((row.id, row.revision, (start + take) as u32));
                    }
                }
                let row_id = row.id;
                if base_found {
                    reread.push((meta, row));
                }
                entry.unfinished = unfinished;
                if entry.unfinished.is_some() {
                    stopped = true;
                    exhausted = false;
                    break;
                }
                entry.after = Some(row_id);
                processed += 1;
                if views.len() == limit as usize {
                    stopped = true;
                    break;
                }
            }
        }
        // Only a short metadata read establishes EOF. Empty views with next
        // are valid actual progress.
        let more = entry.unfinished.is_some() || processed < selected || !exhausted;
        self.host.entropy.fill(&mut entry.token.0);
        let page = BasesDiscoveryPage {
            views,
            clock: entry.clock.clone(),
            collection_revision: entry.fence.collection_revision(),
            next: more.then_some(entry.token),
        };
        self.recheck_discovery(session, &entry)?;
        let output = encode(self, &page, &mut ledger)?;
        self.recheck_discovery(session, &entry)?;
        // FINAL source CAS rereads every Base this page classified, on the SAME
        // ledger and source meter after codec. Every other selected source
        // yielded nothing, and the fence and head recheck below cover it.
        if !reread.is_empty() {
            ledger
                .retain(reserved_bytes + (reread.len() as u64) * 512)
                .map_err(failure)?;
            let ids: Vec<_> = reread.iter().map(|(meta, _)| meta.id).collect();
            let final_rows = self.discovery_hydrate(&ids, entry.head, &mut sources)?;
            if final_rows.len() != reread.len() {
                return Err(stale_discovery());
            }
            for (actual, (meta, expected)) in final_rows.iter().zip(&reread) {
                self.check_discovery_source(actual, expected.id, meta.encoded_bytes, &mut ledger)?;
                if actual.path != expected.path
                    || actual.path_key != expected.path_key
                    || actual.revision != expected.revision
                    || actual.doc != expected.doc
                {
                    return Err(stale_discovery());
                }
            }
        }
        self.recheck_discovery(session, &entry)?;
        if more {
            // The public encoder may re-enter and publish other sessions' slots.
            // Re-admit residency at the actual insertion, never assume its
            // pre-codec count remains authoritative.
            if !self.bases_discovery.entries.contains_key(&session)
                && self.bases_discovery.entries.len() >= MAX_SLOTS
            {
                return Err(budget("bases_discovery_slots"));
            }
            self.bases_discovery.entries.insert(session, entry);
        } else {
            self.bases_discovery.remove(session);
        }
        Ok(output)
    }
    /// Read one exact current declaration's source; never select by an alias/path.
    pub fn encode_bases_view_source<T>(
        &mut self,
        session: SessionId,
        selection: BasesViewSelection,
        timezone: Option<&str>,
        encode: impl FnOnce(&mut Self, &BasesViewSource, &mut IncrementalBasesBudget) -> ApiResult<T>,
    ) -> ApiResult<T> {
        self.authorize_bases_read(session)?;
        if timezone.is_some_and(|zone| zone.len() > 128) {
            return Err(invalid());
        }
        let mut ledger = IncrementalBasesBudget::new();
        ledger.retain(SLOT_BYTES).map_err(failure)?;
        let entry = self.new_discovery(timezone)?;
        self.recheck_discovery(session, &entry)?;
        ledger.retain(16 * 1024).map_err(failure)?;
        let source_bytes = self.bases_local_source_bytes(selection, entry.head)?;
        if source_bytes > INITIAL_BYTES {
            return Err(budget("bases_view_source_bytes"));
        }
        // Cover the bounded encoded record and parsed/output source ownership
        // before hydrate. Both copies use this SAME two-read source ledger.
        ledger.retain(1024 * 1024).map_err(failure)?;
        let mut sources = QueryBudget::new(2, 1024 * 1024);
        let rows = self
            .bases_local_hydrate(&[selection.record], entry.head, &mut sources)
            .map_err(source_error)?;
        let row = rows
            .first()
            .filter(|_| rows.len() == 1)
            .ok_or_else(invalid)?;
        if row.doc.len() as u64 > source_bytes {
            return Err(stale_discovery());
        }
        self.check_discovery_source(row, selection.record, source_bytes, &mut ledger)?;
        if row.revision != selection.revision {
            return Err(stale_discovery());
        }
        let (document, footprint) = ledger
            .admit(|work| {
                if !work.charge(row.doc.len() as u64, row.doc.len() as u64) {
                    return Err(work.failure().expect("exact source document"));
                }
                Document::parse_at_bounded(&row.path, &row.doc)
                    .map_err(|_| EvaluationFailure::BudgetExceeded("base_source_structure"))
            })
            .map_err(failure)?;
        ledger
            .retain(footprint.estimated_heap_bytes)
            .map_err(failure)?;
        let base = ledger
            .admit(|work| {
                if !work.charge(footprint.values, footprint.estimated_heap_bytes) {
                    return Err(work.failure().expect("exact source structure"));
                }
                discover_base_record(
                    self.bases_read_catalog(),
                    &row.path,
                    &document,
                    &entry.clock,
                    work,
                )
            })
            .map_err(failure)?
            .ok_or_else(invalid)?;
        let view = base
            .views
            .iter()
            .find(|view| view.index == selection.index)
            .ok_or_else(invalid)?;
        let retained = row.path.len()
            + row.doc.len()
            + view.view_type.len()
            + view.name.map_or(0, str::len)
            + base
                .implementations
                .iter()
                .map(|i| i.type_name.len() + 256)
                .sum::<usize>()
            + 256;
        ledger.retain(retained as u64).map_err(failure)?;
        ledger
            .admit(|work| {
                if work.charge(1, retained as u64) {
                    Ok(())
                } else {
                    Err(work.failure().expect("exact source result"))
                }
            })
            .map_err(failure)?;
        let result = BasesViewSource {
            source: row.doc.clone(),
            clock: entry.clock.clone(),
            collection_revision: entry.fence.collection_revision(),
            view: BasesViewDescriptor {
                record: row.id,
                path: row.path.clone(),
                revision: row.revision,
                index: view.index,
                name: view.name.map(str::to_owned),
                view_type: view.view_type.to_owned(),
                implementations: base
                    .implementations
                    .iter()
                    .map(|i| BasesImplementationDescriptor {
                        type_name: i.type_name.clone(),
                        version: i.version.to_string(),
                        contract_digest: B32(i.contract_digest.0),
                        implementation_digest: B32(i.digest.0),
                    })
                    .collect(),
            },
        };
        self.recheck_discovery(session, &entry)?;
        let output = encode(self, &result, &mut ledger)?;
        self.recheck_discovery(session, &entry)?;
        ledger.retain(1024 * 1024).map_err(failure)?;
        let final_rows = self
            .bases_local_hydrate(&[selection.record], entry.head, &mut sources)
            .map_err(source_error)?;
        let final_row = final_rows
            .first()
            .filter(|_| final_rows.len() == 1)
            .ok_or_else(stale_discovery)?;
        self.check_discovery_source(final_row, row.id, row.doc.len() as u64, &mut ledger)?;
        if final_row.path != row.path
            || final_row.path_key != row.path_key
            || final_row.revision != row.revision
            || final_row.doc != row.doc
        {
            return Err(stale_discovery());
        }
        self.recheck_discovery(session, &entry)?;
        Ok(output)
    }
    /// Hydrate one page's identities, in order, in store-sized calls that all
    /// charge the page's ONE source ledger.
    fn discovery_hydrate(
        &self,
        ids: &[Uuid],
        head: Head,
        sources: &mut QueryBudget,
    ) -> ApiResult<Vec<LocalRecord>> {
        let mut rows = Vec::with_capacity(ids.len());
        for chunk in ids.chunks(METADATA_ROWS as usize) {
            rows.extend(
                self.bases_local_hydrate(chunk, head, sources)
                    .map_err(source_error)?,
            );
        }
        Ok(rows)
    }
    fn check_discovery_source(
        &self,
        row: &LocalRecord,
        id: Uuid,
        encoded_bytes: u64,
        ledger: &mut IncrementalBasesBudget,
    ) -> ApiResult<()> {
        if row.id != id
            || row.doc.len() as u64 > encoded_bytes
            || row.path.len() > 4096
            || row.doc.len() > INITIAL_BYTES as usize
            || row.path_key != mdbn_core::paths::path_key(&row.path)
            || !self.bases_local_holder_matches(row)?
        {
            return Err(invalid());
        }
        ledger
            .admit(|work| {
                if work.charge(row.doc.len() as u64, 0) {
                    Ok(())
                } else {
                    Err(work.failure().expect("discovery hash"))
                }
            })
            .map_err(failure)?;
        if B32(Sha256::digest(row.doc.as_bytes()).into()) != row.revision {
            return Err(invalid());
        }
        Ok(())
    }
}
