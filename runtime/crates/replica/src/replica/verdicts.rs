//! The apply verdicts that record history lists from (`replica-client-api.md` §4.4).
//!
//! History may list only entries this replica applied. Whether an entry applied
//! or was void depends on the state before it (`log-entry.md` §4.3), so it can't be
//! worked out again from the log. The apply path keeps a record instead: the
//! positions it judged itself, `(from, to]`, and which of them were void. That
//! is one device-local meta value, written in the same transaction as each item's
//! head ([`super::Replica::commit_retained`]), so the record is exactly as durable
//! as the verdicts it describes.
//!
//! A head that moves any other way (a snapshot install, a lost-tail rollback, an
//! adoption) breaks the run: the next verdict starts a new one at the head before
//! it. Positions below a run's start are never listed. When more than [`MAX_VOIDS`]
//! positions are void, the run starts after the oldest, so the record stays small.

use std::collections::BTreeSet;

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::Hash;
use mdbn_wire::schema::Wire;

use crate::store::{Head, Store, StoreResult};

/// `CBOR [1, from, to.seq, to.chain, [void seq, ...]]`. Device-local.
pub(crate) const META: &str = "replica.verdicts";
/// Void positions kept: a void is rare, and history stops above the oldest dropped.
const MAX_VOIDS: usize = 256;

/// What the apply path decided for one item.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Verdict {
    Applied,
    Void,
}

/// The positions this replica judged, `(from, to.seq]`, and the void ones.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Verdicts {
    pub(crate) from: u64,
    pub(crate) to: Head,
    pub(crate) voids: BTreeSet<u64>,
}

impl Verdicts {
    fn empty(at: Head) -> Verdicts {
        Verdicts {
            from: at.seq,
            to: at,
            voids: BTreeSet::new(),
        }
    }

    /// The stored record. One that does not decode only shortens history, so it
    /// reads as no record and the next verdict starts a new run.
    pub(crate) fn load<S: Store + ?Sized>(store: &S) -> StoreResult<Option<Verdicts>> {
        Ok(store.meta(META)?.and_then(|b| decode(&b)))
    }

    /// The record as of the replica's applied `head`: empty there when the run
    /// does not end at it.
    pub(crate) fn at<S: Store + ?Sized>(store: &S, head: Head) -> StoreResult<Verdicts> {
        Ok(Verdicts::load(store)?
            .filter(|v| v.to == head)
            .unwrap_or_else(|| Verdicts::empty(head)))
    }

    /// The record after the item at `head`, applied on top of `before`.
    pub(crate) fn next(
        prior: Option<Verdicts>,
        before: Head,
        head: Head,
        verdict: Verdict,
    ) -> Verdicts {
        let mut v = prior
            .filter(|v| v.to == before)
            .unwrap_or_else(|| Verdicts::empty(before));
        v.to = head;
        if verdict == Verdict::Void {
            v.voids.insert(head.seq);
            if v.voids.len() > MAX_VOIDS
                && let Some(oldest) = v.voids.pop_first()
            {
                v.from = oldest;
            }
        }
        v
    }

    pub(crate) fn encode(&self) -> Vec<u8> {
        cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            Cbor::Uint(self.from),
            Cbor::Uint(self.to.seq),
            self.to.chain.to_cbor(),
            Cbor::Array(self.voids.iter().map(|s| Cbor::Uint(*s)).collect()),
        ]))
        .expect("a verdict record encodes")
    }
}

fn decode(bytes: &[u8]) -> Option<Verdicts> {
    let Cbor::Array(a) = cbor::decode(bytes).ok()? else {
        return None;
    };
    let [
        Cbor::Uint(1),
        Cbor::Uint(from),
        Cbor::Uint(seq),
        chain,
        Cbor::Array(voids),
    ] = a.as_slice()
    else {
        return None;
    };
    let voids = voids
        .iter()
        .map(|v| match v {
            Cbor::Uint(s) if s > from && s <= seq => Some(*s),
            _ => None,
        })
        .collect::<Option<BTreeSet<u64>>>()?;
    (from <= seq && voids.len() <= MAX_VOIDS).then_some(Verdicts {
        from: *from,
        to: Head {
            seq: *seq,
            chain: Hash::from_cbor(chain).ok()?,
        },
        voids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::B32;

    fn head(seq: u64) -> Head {
        Head {
            seq,
            chain: B32([u8::try_from(seq % 251).unwrap(); 32]),
        }
    }

    #[test]
    fn a_run_extends_from_its_own_head_and_restarts_after_any_other_move() {
        let v = Verdicts::next(None, head(4), head(5), Verdict::Applied);
        assert_eq!((v.from, v.to), (4, head(5)));
        let v = Verdicts::next(Some(v), head(5), head(6), Verdict::Void);
        let v = Verdicts::next(Some(v), head(6), head(7), Verdict::Applied);
        assert_eq!(
            (v.from, v.voids.iter().copied().collect::<Vec<_>>()),
            (4, vec![6])
        );
        assert_eq!(decode(&v.encode()), Some(v.clone()));

        // The head moved without a verdict (an install at 9): a new run.
        let w = Verdicts::next(Some(v.clone()), head(9), head(10), Verdict::Applied);
        assert_eq!((w.from, w.voids.len()), (9, 0));
        // Same position, another chain: also a new run.
        let other = Head {
            seq: 7,
            chain: B32([0xee; 32]),
        };
        assert_eq!(
            Verdicts::next(Some(v), other, head(8), Verdict::Applied).from,
            7
        );
    }

    #[test]
    fn too_many_voids_move_the_start_above_the_oldest() {
        let mut v = Verdicts::next(None, head(0), head(1), Verdict::Void);
        for s in 2..=u64::try_from(MAX_VOIDS).unwrap() + 1 {
            v = Verdicts::next(Some(v), head(s - 1), head(s), Verdict::Void);
        }
        assert_eq!((v.from, v.voids.len()), (1, MAX_VOIDS));
        assert_eq!(v.voids.first(), Some(&2));
        assert_eq!(decode(&v.encode()), Some(v));
    }
}
