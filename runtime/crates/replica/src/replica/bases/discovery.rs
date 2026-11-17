//! Bounded primary UUID inventory discovery. No type-index shortcut or fallback.
use super::*;
use crate::{api::SessionId, store::Head, store_query::QueryRecordSize};
use mdbn_core::views::bases::IncrementalBasesBudget;
use std::collections::BTreeMap;

/// Identities per metadata read and per hydration call; the local source
/// helpers accept at most 128.
const METADATA_ROWS: u32 = 128;
/// One page's source work is the whole binding 1000-record / 1 MiB profile,
/// under ONE ledger, and that profile still binds every page. Every selected
/// source is read once to classify it; only a source that classifies as a Base
/// is read again by the page's final CAS, and the page reserves that reread
/// before it keeps the Base.
const PAGE_ROWS: u32 = 1000;
const PAGE_BYTES: u64 = 1 << 20;
/// The largest Base: half the page, so a Base can always be classified and
/// reread within one page. Only a Base is reread, so any other record may be
/// as large as the page itself; the scan's reread check is what holds a Base
/// to this bound (tasknotes-app#436: a 512 KiB-1 MiB note failed discovery).
const MAX_BASE_BYTES: u64 = PAGE_BYTES / 2;
const SLOT_BYTES: u64 = 4096;
/// A discovery REQUEST is bounded by time across pages, not by one page's
/// bytes: it serves further pages of the same frozen cut until one has a view,
/// the universe ends, or about this much host-clock time has passed since the
/// request started. Discovery reads every record, and on a Private collection
/// each request is a relayed round trip, so one page per request cost a round
/// trip per MiB of notes before the first view (tasknotes-app#436, ~33 round
/// trips and 19.5 s). Each page stays bounded by the profile above.
const REQUEST_WORK_MS: i64 = 1_500;
/// Backstop for a host clock that does not advance (it need not be monotonic):
/// at most this many pages, each bounded by the profile, per request.
const MAX_PAGES_PER_REQUEST: u32 = 256;

const MAX_SLOTS: usize = 64;
/// Unreadable records one page may name. A page that reaches it ends there,
/// as one that reaches its view limit does.
const MAX_UNREADABLE: usize = 32;

/// What discovery does with a record it cannot classify: one whose own
/// frontmatter, types or Bases fields are unusable (`BaseRecord::Unreadable`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UnreadableSources {
    /// Refuse the whole discovery, as request version 1 always has.
    Refuse,
    /// Skip the record and name it in the page, so the result is complete
    /// except for the records it names (request version 2).
    Report,
}
/// A record discovery skipped. Whether it declares views is unknown.
pub struct BasesUnreadableSource {
    /// The record's identity.
    pub record: Uuid,
    /// Its path under the frozen cut.
    pub path: String,
    /// Its source revision under the frozen cut.
    pub revision: Hash,
    /// Why it could not be classified.
    pub problem: EvaluationFailure,
}

/// A separate native discovery continuation, never a Query/execution cursor.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct BasesDiscoveryHandle(pub [u8; 32]);
/// One bounded page under a frozen native discovery cut.
pub struct BasesDiscoveryPage {
    /// Exact source identities and original declaration ordinals.
    pub views: Vec<BasesViewDescriptor>,
    /// Records skipped as unreadable, in identity order. Always empty under
    /// `UnreadableSources::Refuse`.
    pub unreadable: Vec<BasesUnreadableSource>,
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
/// One classified page, before its final CAS and (for the replying page) codec.
struct ScannedPage {
    views: Vec<BasesViewDescriptor>,
    unreadable: Vec<BasesUnreadableSource>,
    reread: Vec<(QueryRecordSize, LocalRecord)>,
    reserved_bytes: u64,
    sources: QueryBudget,
    more: bool,
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
    /// Read bounded pages of one frozen cut until a page has a view, the
    /// universe ends or the request's time budget is spent, and encode that
    /// page INSIDE the original publication fence. A supplied handle is
    /// single-use. Drift/failed consumption requires fresh discovery, never an
    /// implicit new-cut retry. Caller uses zeroizing output.
    pub fn encode_bases_discovery_page<T>(
        &mut self,
        session: SessionId,
        timezone: Option<&str>,
        limit: u32,
        resume: Option<BasesDiscoveryHandle>,
        unreadable: UnreadableSources,
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
        // Serve pages under the SAME frozen cut until one has a view, the
        // universe ends, or the request's time budget is spent. Each page is
        // exactly one bounded page (its own source profile and ledger, every
        // record classified, its own final CAS); only the page that replies is
        // encoded. Without this, a vault of notes cost one relayed round trip
        // per page before the first view (tasknotes-app#436).
        let started = self.now();
        let mut pages = 0u32;
        loop {
            pages += 1;
            let mut scan =
                self.discovery_scan_page(session, &mut entry, limit, unreadable, &mut ledger)?;
            let spent = pages >= MAX_PAGES_PER_REQUEST
                || self.now().saturating_sub(started) >= REQUEST_WORK_MS;
            // Only the replying page is published, so a page that names an
            // unreadable record replies as one with a view does.
            if !scan.views.is_empty() || !scan.unreadable.is_empty() || !scan.more || spent {
                return self.publish_discovery_page(session, entry, scan, ledger, encode);
            }
            // A page without views still proves its own Bases before the next
            // page reads on; nothing of it is published.
            self.recheck_discovery(session, &entry)?;
            self.discovery_final_cas(&entry, &mut scan, &mut ledger)?;
            self.recheck_discovery(session, &entry)?;
            ledger = IncrementalBasesBudget::new();
            ledger.retain(SLOT_BYTES).map_err(failure)?;
        }
    }
    /// Select, read and classify one bounded page of the frozen discovery
    /// universe, advancing `entry` past every processed record. Nothing is
    /// published or encoded here.
    fn discovery_scan_page(
        &mut self,
        session: SessionId,
        entry: &mut Entry,
        limit: u32,
        mode: UnreadableSources,
        ledger: &mut IncrementalBasesBudget,
    ) -> ApiResult<ScannedPage> {
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
        let mut unreadable = Vec::new();
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
            self.recheck_discovery(session, entry)?;
            for (row, meta) in rows.into_iter().zip(admitted) {
                self.check_discovery_source(&row, meta.id, meta.encoded_bytes, ledger)?;
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
                let classified = ledger
                    .admit(|work| {
                        if !work.charge(footprint.values, footprint.estimated_heap_bytes) {
                            return Err(work.failure().expect("discovery structure"));
                        }
                        classify_base_record(
                            self.bases_read_catalog(),
                            &row.path,
                            &document,
                            &entry.clock,
                            work,
                        )
                    })
                    .map_err(failure)?;
                let base = match classified {
                    BaseRecord::NotBase => None,
                    BaseRecord::Base(base) => Some(base),
                    BaseRecord::Unreadable(problem) if mode == UnreadableSources::Refuse => {
                        return Err(failure(problem));
                    }
                    BaseRecord::Unreadable(problem) => {
                        let retained = row.path.len() as u64 + 256;
                        ledger.retain(retained).map_err(failure)?;
                        ledger
                            .admit(|work| {
                                if work.charge(1, retained) {
                                    Ok(())
                                } else {
                                    Err(work.failure().expect("unreadable source"))
                                }
                            })
                            .map_err(failure)?;
                        unreadable.push(BasesUnreadableSource {
                            record: row.id,
                            path: row.path.clone(),
                            revision: row.revision,
                            problem,
                        });
                        None
                    }
                };
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
                if views.len() == limit as usize || unreadable.len() == MAX_UNREADABLE {
                    stopped = true;
                    break;
                }
            }
        }
        // Only a short metadata read establishes EOF. Empty views with next
        // are valid actual progress.
        let more = entry.unfinished.is_some() || processed < selected || !exhausted;
        Ok(ScannedPage {
            views,
            unreadable,
            reread,
            reserved_bytes,
            sources,
            more,
        })
    }
    /// FINAL source CAS: reread every Base the page classified, on the SAME
    /// ledger and source meter. Every other selected source yielded nothing,
    /// and the caller's fence and head recheck cover it.
    fn discovery_final_cas(
        &self,
        entry: &Entry,
        scan: &mut ScannedPage,
        ledger: &mut IncrementalBasesBudget,
    ) -> ApiResult<()> {
        if scan.reread.is_empty() {
            return Ok(());
        }
        ledger
            .retain(scan.reserved_bytes + (scan.reread.len() as u64) * 512)
            .map_err(failure)?;
        let ids: Vec<_> = scan.reread.iter().map(|(meta, _)| meta.id).collect();
        let final_rows = self.discovery_hydrate(&ids, entry.head, &mut scan.sources)?;
        if final_rows.len() != scan.reread.len() {
            return Err(stale_discovery());
        }
        for (actual, (meta, expected)) in final_rows.iter().zip(&scan.reread) {
            self.check_discovery_source(actual, expected.id, meta.encoded_bytes, ledger)?;
            if actual.path != expected.path
                || actual.path_key != expected.path_key
                || actual.revision != expected.revision
                || actual.doc != expected.doc
            {
                return Err(stale_discovery());
            }
        }
        Ok(())
    }
    /// Encode the replying page INSIDE the original publication fence, then
    /// run its final CAS after codec and publish or release the slot.
    fn publish_discovery_page<T>(
        &mut self,
        session: SessionId,
        mut entry: Entry,
        mut scan: ScannedPage,
        mut ledger: IncrementalBasesBudget,
        encode: impl FnOnce(&mut Self, &BasesDiscoveryPage, &mut IncrementalBasesBudget) -> ApiResult<T>,
    ) -> ApiResult<T> {
        let more = scan.more;
        self.host.entropy.fill(&mut entry.token.0);
        let page = BasesDiscoveryPage {
            views: std::mem::take(&mut scan.views),
            unreadable: std::mem::take(&mut scan.unreadable),
            clock: entry.clock.clone(),
            collection_revision: entry.fence.collection_revision(),
            next: more.then_some(entry.token),
        };
        self.recheck_discovery(session, &entry)?;
        let output = encode(self, &page, &mut ledger)?;
        self.recheck_discovery(session, &entry)?;
        self.discovery_final_cas(&entry, &mut scan, &mut ledger)?;
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
        if source_bytes > MAX_BASE_BYTES {
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
            || row.doc.len() as u64 > PAGE_BYTES
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
