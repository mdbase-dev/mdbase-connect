//! Other authors' lost entries (lost-tail §5 step 7, §6): after a rollback, the
//! entries of other devices in the rolled-back window `(L, H]` are not
//! re-appended here; their authors resurrect them. This replica records them as
//! orphans `(author, mutation, old seq, since)` in a bounded meta row. An orphan
//! clears when its mutation ID shows up in the applied log. If it is still
//! missing after the grace (24 hours by default) or once its author is revoked,
//! it is reported in `lost_entries: 11`, one entry per author:
//! `{author, count, lowest_seq, mutations}`. This device's own resurrected writes
//! that were lost after revocation are reported there too.

use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B16, Uuid, Value};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::schema::Wire;

use super::Replica;
use crate::store::{MetaPut, Store, StoreError, Tx, meta_keys};

/// Default grace before an orphan counts as lost (§5 step 7).
pub const ORPHAN_GRACE_MS: i64 = 24 * 60 * 60 * 1000;
/// At most this many orphans are tracked (bounded by the retained window).
const MAX_ORPHANS: usize = 10_000;

/// One other author's entry lost with the tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Orphan {
    /// Author device (the item's signer).
    pub author: Uuid,
    /// Mutation ID.
    pub mutation: Uuid,
    /// Its earlier position.
    pub seq: u64,
    /// When it was recorded (host clock).
    pub since: i64,
    /// Reported lost (grace passed, author revoked, or lost after revocation).
    pub lost: bool,
}

const RECORD: usize = 16 + 16 + 8 + 8 + 1;

/// Canonical hyphenated lowercase UUID text.
fn uuid_text(u: &Uuid) -> String {
    let h: String = u.0.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

pub(crate) fn encode(orphans: &[Orphan]) -> Vec<u8> {
    let mut out = Vec::with_capacity(orphans.len() * RECORD);
    for o in orphans {
        out.extend_from_slice(&o.author.0);
        out.extend_from_slice(&o.mutation.0);
        out.extend_from_slice(&o.seq.to_be_bytes());
        out.extend_from_slice(&o.since.to_be_bytes());
        out.push(u8::from(o.lost));
    }
    out
}

pub(crate) fn decode(b: Option<&[u8]>) -> Result<Vec<Orphan>, &'static str> {
    let Some(b) = b else {
        return Ok(Vec::new());
    };
    if b.len() % RECORD != 0 {
        return Err("length");
    }
    b.chunks_exact(RECORD)
        .map(|r| {
            let id = |o: usize| {
                let mut x = [0u8; 16];
                x.copy_from_slice(&r[o..o + 16]);
                B16(x)
            };
            let word = |o: usize| {
                let mut x = [0u8; 8];
                x.copy_from_slice(&r[o..o + 8]);
                x
            };
            Ok(Orphan {
                author: id(0),
                mutation: id(16),
                seq: u64::from_be_bytes(word(32)),
                since: i64::from_be_bytes(word(40)),
                lost: match r[48] {
                    0 => false,
                    1 => true,
                    _ => return Err("flag"),
                },
            })
        })
        .collect()
}

pub(crate) fn meta(orphans: &[Orphan]) -> MetaPut {
    (
        meta_keys::ORPHANS.into(),
        (!orphans.is_empty()).then(|| encode(orphans)),
    )
}

impl<S: Store> Replica<S> {
    /// Tracked orphans (other authors' lost entries, and own writes lost after
    /// revocation).
    pub fn orphans(&self) -> &[Orphan] {
        &self.orphans
    }

    /// Set the orphan grace (sim tuning; default 24 hours).
    pub fn set_orphan_grace(&mut self, ms: i64) {
        self.orphan_grace_ms = ms.max(0);
        let _ = self.review_orphans();
    }

    /// The orphans of a rolled-back window: other authors' entries in the
    /// retained rows `(l, h]`. Undecodable or unopenable entries are recorded
    /// with a zero mutation ID (their author is still known from the envelope).
    pub(crate) fn window_orphans(&self, l: u64, h: u64) -> Result<Vec<Orphan>, StoreError> {
        let now = self.now();
        let mut out = Vec::new();
        let mut after = l;
        while after < h && out.len() < MAX_ORPHANS {
            let Some(row) = self.store.tail(after, 1)?.into_iter().next() else {
                break;
            };
            after = row.seq;
            let Ok(item) = Item::from_bytes(&row.item) else {
                continue;
            };
            if item.kind != ItemKind::Entry {
                continue;
            }
            let Some(author) = item.signer else {
                continue;
            };
            let payload = self
                .sealer
                .open(&item, &row.item)
                .ok()
                .and_then(|plain| super::attachment_runtime::entry_mutation(&plain));
            if payload
                .as_ref()
                .is_some_and(|m| m.origin == self.cfg.replica_id)
            {
                continue; // own: resurrected from own-retained rows instead
            }
            out.push(Orphan {
                author,
                mutation: payload.map_or(B16([0; 16]), |m| m.id),
                seq: row.seq,
                since: now,
                lost: false,
            });
        }
        Ok(out)
    }

    /// The orphan list with this device's own resurrected writes lost after
    /// revocation added (for the resolving transaction; adopt after commit).
    pub(crate) fn with_lost_own(&self, lost: &[(Uuid, u64)]) -> Vec<Orphan> {
        let now = self.now();
        let mut next = self.orphans.clone();
        for (mutation, seq) in lost {
            next.push(Orphan {
                author: self.cfg.device_id,
                mutation: *mutation,
                seq: *seq,
                since: now,
                lost: true,
            });
        }
        next
    }

    /// Clear orphans whose mutation is in the applied log; mark those past the
    /// grace (or by a revoked author) lost. Persisted when anything changes.
    pub(crate) fn review_orphans(&mut self) -> Result<(), StoreError> {
        if self.orphans.is_empty() || self.rolling_back() {
            return Ok(());
        }
        let now = self.now();
        let mut next = Vec::with_capacity(self.orphans.len());
        for o in &self.orphans {
            let back = o.mutation != B16([0; 16]) && self.store.receipt(&o.mutation)?.is_some();
            if back {
                continue;
            }
            let revoked = self.policy.devices.get(&o.author).is_none_or(|d| !d.active);
            let mut o = *o;
            o.lost |= revoked || now >= o.since.saturating_add(self.orphan_grace_ms);
            next.push(o);
        }
        if next != self.orphans {
            self.store.commit(Tx {
                meta: vec![meta(&next)],
                ..Tx::default()
            })?;
            self.orphans = next;
        }
        self.refresh_lost_entries();
        Ok(())
    }

    /// `lost_entries: 11`, one entry per author, while any orphan is lost.
    pub(crate) fn refresh_lost_entries(&mut self) {
        let mut by_author: std::collections::BTreeMap<Uuid, Vec<&Orphan>> = Default::default();
        for o in self.orphans.iter().filter(|o| o.lost) {
            by_author.entry(o.author).or_default().push(o);
        }
        let int = |v: u64| Value::Int(i64::try_from(v).unwrap_or(i64::MAX));
        // The held fallback (the divergence can't be proven) needs the user's
        // attention: it is listed first, with a fixed reason and an action.
        let held = self.held_unprovable().map(|(from, service)| {
            Value::Map(vec![
                ("reason".into(), Value::Text("needs_attention".into())),
                ("cause".into(), Value::Text("lost_tail_unprovable".into())),
                ("from".into(), int(from)),
                ("service_head".into(), int(service)),
                (
                    "action".into(),
                    Value::Text(
                        "The sync service lost recent changes and this device can't tell exactly which; it stopped syncing to keep your data and access safe. Contact support.".into(),
                    ),
                ),
            ])
        });
        if by_author.is_empty() && held.is_none() {
            self.clear_incident(IncidentKind::LostEntries);
            return;
        }
        let authors = held
            .into_iter()
            .chain(by_author.into_iter().map(|(author, os)| {
                Value::Map(vec![
                    ("author".into(), Value::Text(uuid_text(&author))),
                    ("count".into(), int(os.len() as u64)),
                    (
                        "lowest_seq".into(),
                        int(os.iter().map(|o| o.seq).min().unwrap_or(0)),
                    ),
                    (
                        "mutations".into(),
                        Value::List(
                            os.iter()
                                .filter(|o| o.mutation != B16([0; 16]))
                                .map(|o| Value::Text(uuid_text(&o.mutation)))
                                .collect(),
                        ),
                    ),
                ])
            }))
            .collect();
        self.incident(IncidentKind::LostEntries, Some(Value::List(authors)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orphans_round_trip() {
        let o = vec![
            Orphan {
                author: B16([1; 16]),
                mutation: B16([2; 16]),
                seq: 9,
                since: -5,
                lost: false,
            },
            Orphan {
                author: B16([3; 16]),
                mutation: B16([0; 16]),
                seq: 10,
                since: 7,
                lost: true,
            },
        ];
        assert_eq!(decode(Some(&encode(&o))), Ok(o.clone()));
        assert_eq!(decode(None), Ok(Vec::new()));
        assert!(decode(Some(&[0u8; 3])).is_err());
        assert_eq!(meta(&[]).1, None);
    }
}
