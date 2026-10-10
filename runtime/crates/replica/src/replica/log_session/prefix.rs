//! Authenticated prefix observation for the lost-tail repair.
//! Prefix evidence is captured through the current authenticated session.
//!
//! A probe read's reply becomes evidence about the service's prefix ONLY when it
//! arrived through the matched, current authenticated session
//! ([`super::MatchedLogReply`]) and describes exactly the interval the immutable
//! original request asked for: unfiltered, within the item/byte bounds,
//! positions `after+1 ..= after+n` without gaps, each item linking from its
//! predecessor, and the service's head at or above the last item. The trust
//! anchor is the locally retained predecessor at `after` (position 0 is
//! `CHAIN_ZERO`); the captured local head is a lifetime fence only.
//!
//! Nothing here authorizes an install, a latch clear, restored rights or control
//! supersession: an observation is a matched canonical prefix comparison and
//! nothing more. Legacy `LogPort` delivery (no provenance) can never mint one.

use std::sync::Arc;

use mdbn_wire::common::{Hash, Uuid};
use mdbn_wire::envelope::Item;
use mdbn_wire::hash::{CHAIN_ZERO, chain_hash};
use mdbn_wire::log_service::ReadResult;
use mdbn_wire::schema::Wire;

use super::{AuthenticatedLogSession, MatchedLogReply, SessionIdentity};
use crate::log::EndpointId;
use crate::store::Head;

/// The locally trusted predecessor of the requested interval: the retained
/// chain at `request.after` (`CHAIN_ZERO` at 0), or unknown when that position
/// is outside this replica's retained window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Anchor {
    pub(crate) seq: u64,
    pub(crate) chain: Option<Hash>,
}

impl Anchor {
    /// Genesis: the empty prefix every log shares. Still only an anchor: it
    /// proves nothing about the service until a matched reply is observed.
    pub(crate) const GENESIS: Anchor = Anchor {
        seq: 0,
        chain: Some(CHAIN_ZERO),
    };
}

/// Why a reply is not prefix evidence. Never an incident on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PrefixRefusal {
    /// Delivered without authenticated provenance (legacy `LogPort`).
    NoProvenance,
    /// The matched session is not the exact current one.
    StaleSession,
    /// The original call was not a read.
    NotARead,
    /// The original read was kind-filtered; a filtered interval is incomplete.
    Filtered,
    /// The caller's anchor is not the original `after`.
    WrongAnchor,
    /// The service compacted the requested interval.
    Compacted,
    /// The service's head is below the requested interval (its view changed).
    Moved,
    /// The reply does not describe the requested interval (count, positions,
    /// parse, contradiction between `behind` and `retained_from`, head).
    Shape,
    /// More raw bytes than the request allowed.
    Bounds,
    /// The reply's own items do not link to each other.
    Chain,
}

/// One validated observation of the service's prefix over the requested
/// interval, bound to the session, collection, endpoint and local store instance
/// it was taken under. Private fields: nothing relabels it.
#[derive(Debug, Clone)]
pub(crate) struct PrefixObservation {
    session: Arc<SessionIdentity>,
    collection: Uuid,
    endpoint: EndpointId,
    captured_head: Head,
    anchor: Anchor,
    anchor_matched: bool,
    /// `(seq, chain(item))` for the observed interval, in order.
    items: Vec<(u64, Hash)>,
    store_generation: u64,
}

/// Build an observation from a matched reply, or refuse.
pub(crate) fn observe(
    matched: Option<&MatchedLogReply>,
    current: Option<&AuthenticatedLogSession>,
    reply: &ReadResult,
    anchor: Anchor,
    store_generation: u64,
) -> Result<PrefixObservation, PrefixRefusal> {
    let matched = matched.ok_or(PrefixRefusal::NoProvenance)?;
    let original = &matched.original;
    let session = &original.session.0;
    if !current.is_some_and(|c| Arc::ptr_eq(&c.0, session)) {
        return Err(PrefixRefusal::StaleSession);
    }
    let read = original.read.as_ref().ok_or(PrefixRefusal::NotARead)?;
    if read.kinds.is_some() {
        return Err(PrefixRefusal::Filtered);
    }
    if anchor.seq != read.after {
        return Err(PrefixRefusal::WrongAnchor);
    }
    let after = read.after;
    let n = reply.items.len() as u64;
    if n > read.limit {
        return Err(PrefixRefusal::Shape);
    }
    if reply.behind {
        // "behind" while retaining the next position contradicts itself.
        if reply.retained_from <= after.saturating_add(1) {
            return Err(PrefixRefusal::Shape);
        }
        return Err(PrefixRefusal::Compacted);
    }
    if reply.head < after {
        return Err(PrefixRefusal::Moved);
    }
    if n == 0 && reply.head > after {
        // Not behind, items exist above `after`, yet none were returned.
        return Err(PrefixRefusal::Shape);
    }
    if let Some(max) = read.max_bytes
        && n > 1
        && reply
            .items
            .iter()
            .try_fold(0u64, |acc, it| acc.checked_add(it.item.0.len() as u64))
            .is_none_or(|total| total > max)
    {
        return Err(PrefixRefusal::Bounds);
    }
    let mut items = Vec::with_capacity(reply.items.len());
    let mut expect_seq = after;
    let mut prev: Option<Hash> = anchor.chain;
    let mut anchor_matched = n == 0 && anchor.chain == Some(reply.head_chain);
    for (i, it) in reply.items.iter().enumerate() {
        expect_seq = expect_seq.checked_add(1).ok_or(PrefixRefusal::Shape)?;
        if it.seq != expect_seq {
            return Err(PrefixRefusal::Shape);
        }
        let parsed = Item::from_bytes(&it.item.0).map_err(|_| PrefixRefusal::Shape)?;
        // This collection's well-formed log items only: another collection's or
        // a malformed envelope is never a description of our prefix, however
        // well its positions line up (replica-repair negative). Signature and
        // policy validity are apply's job, not evidence of position here.
        if parsed.collection != session.collection
            || !parsed.kind.is_log_item()
            || parsed.check_shape().is_err()
            || parsed.seq != Some(it.seq)
        {
            return Err(PrefixRefusal::Shape);
        }
        let chain = chain_hash(&it.item.0);
        match (i, prev) {
            // The first item's predecessor is the service's chain at `after`:
            // equal to ours or not, that is an observation, never a refusal.
            (0, Some(ours)) => anchor_matched = parsed.prev == Some(ours),
            (0, None) => {}
            (_, Some(theirs)) if parsed.prev == Some(theirs) => {}
            // The service's own interval does not link: not a prefix.
            (_, _) => return Err(PrefixRefusal::Chain),
        }
        prev = Some(chain);
        items.push((it.seq, chain));
    }
    if reply.head < expect_seq {
        return Err(PrefixRefusal::Shape);
    }
    if reply.head == expect_seq
        && let Some(&(_, last)) = items.last()
        && reply.head_chain != last
    {
        return Err(PrefixRefusal::Shape);
    }
    if n == 0 && after == 0 && anchor_matched && reply.retained_from > 1 {
        // An empty genesis reply counts only while position 1 is retainable.
        return Err(PrefixRefusal::Compacted);
    }
    Ok(PrefixObservation {
        session: session.clone(),
        collection: session.collection,
        endpoint: session.endpoint,
        captured_head: original.captured_head,
        anchor,
        anchor_matched,
        items,
        store_generation,
    })
}

impl PrefixObservation {
    /// The highest position in `[after, after+n]` where the service's chain and
    /// this replica's retained chain agree: a position in `local` matches when
    /// its chain equals the observed item's; the anchor matches when the first
    /// observed item links from it (or an empty reply's head chain equals it).
    /// Never extrapolates above the last observed item or below `after`.
    pub(crate) fn common_position(&self, local: &[(u64, Hash)]) -> Option<u64> {
        let mut best = self.anchor_matched.then_some(self.anchor.seq);
        for &(seq, theirs) in &self.items {
            if local.iter().any(|&(s, ours)| s == seq && ours == theirs) {
                best = Some(best.map_or(seq, |b| b.max(seq)));
            }
        }
        best
    }

    /// The observation is usable only by the exact session, view and store
    /// instance that asked: rechecked immediately before use and after every
    /// external await.
    pub(crate) fn still_valid(
        &self,
        current: Option<&AuthenticatedLogSession>,
        local_head: Head,
        store_generation: u64,
    ) -> bool {
        current.is_some_and(|c| {
            Arc::ptr_eq(&c.0, &self.session)
                && c.0.collection == self.collection
                && c.0.endpoint == self.endpoint
        }) && self.captured_head == local_head
            && self.store_generation == store_generation
    }
}
