//! Oracles: what must hold at the end of every seed.
//!
//! | Oracle | Violation |
//! |---|---|
//! | no lost acknowledged write | a write a client saw confirmed at seq `s` is missing from the final log at `s`, or its effect is gone from the converged state without a later deliberate change |
//! | no lost user edit | a token a user or app wrote is absent from the converged state, every surfaced hold and conflict, and was not deliberately removed or excused ([`Tokens`]) |
//! | convergence | replicas disagree on head, chain or state digest after quiescence |
//! | no plaintext / key material at untrusted parties | see [`crate::tap`] |
//! | holds surfaced | a replica holds something it doesn't report |
//! | determinism | the same seed produced a different run digest |
//!
//! Tokens are unique strings `tk<N>x` that actors write into content. Because they
//! are unique, "is this edit still somewhere" is a substring search, independent of
//! how the content was merged, moved or reformatted.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// A violation class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    /// An acknowledged write is gone.
    LostAck,
    /// A user or app edit is gone without trace.
    LostEdit,
    /// Replicas disagree after quiescence.
    Divergence,
    /// A replica's folder doesn't hold its confirmed records.
    FileMismatch,
    /// The log service saw plaintext.
    Plaintext,
    /// An untrusted party saw key material.
    KeyExposure,
    /// Something is held but not surfaced.
    SilentHold,
    /// The run did not settle.
    NoQuiesce,
    /// A seed's two runs differ.
    Nondeterminism,
    /// A lying log service went undetected where the protocol must detect it.
    UndetectedAttack,
    /// A component panicked or broke an internal invariant.
    Bug,
}

impl fmt::Display for Kind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Kind::LostAck => "lost-ack",
            Kind::LostEdit => "lost-edit",
            Kind::Divergence => "divergence",
            Kind::FileMismatch => "file-mismatch",
            Kind::Plaintext => "plaintext",
            Kind::KeyExposure => "key-exposure",
            Kind::SilentHold => "silent-hold",
            Kind::NoQuiesce => "no-quiesce",
            Kind::Nondeterminism => "nondeterminism",
            Kind::UndetectedAttack => "undetected-attack",
            Kind::Bug => "bug",
        };
        f.write_str(s)
    }
}

/// One violation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    /// Class.
    pub kind: Kind,
    /// Details (forensics).
    pub detail: String,
}

/// Token bookkeeping for the lost-edit oracle.
#[derive(Debug, Default, Clone)]
pub struct Tokens {
    next: u64,
    /// token -> writer.
    pub written: BTreeMap<String, String>,
    /// Deliberately removed by an actor that saw them.
    pub removed: BTreeSet<String>,
    /// Never applied: the write was rejected or failed, and its writer was told.
    pub discarded: BTreeSet<String>,
    /// Lost by the user's own tools, not by us: unsynced editor bytes on power
    /// loss, bytes an editor wrote into an inode nothing links any more, an editor
    /// reverting a concurrent change (counted separately: [`Tokens::editor_reverted`]).
    pub excused: BTreeMap<String, &'static str>,
}

impl Tokens {
    /// How many tokens were minted: the scenario's write count.
    pub fn minted(&self) -> u64 {
        self.next
    }
    /// A fresh unique token written by `actor`.
    pub fn fresh(&mut self, actor: &str) -> String {
        self.next += 1;
        let t = format!("tk{:0w$}x", self.next, w = TOKEN_DIGITS);
        self.written.insert(t.clone(), actor.to_string());
        t
    }
    /// The token was never actually written (overwritten before saving).
    pub fn unwrite(&mut self, t: &str) {
        self.written.remove(t);
    }
    /// An actor deliberately removed `t`.
    pub fn remove(&mut self, t: &str) {
        self.removed.insert(t.to_string());
    }
    /// The write carrying `t` was rejected and its writer told.
    pub fn discard(&mut self, t: &str) {
        self.discarded.insert(t.to_string());
    }
    /// `t` was lost outside our responsibility.
    pub fn excuse(&mut self, t: &str, why: &'static str) {
        self.excused.entry(t.to_string()).or_insert(why);
    }
    /// Tokens excused for a reason.
    pub fn excused_count(&self, why: &str) -> usize {
        self.excused.values().filter(|w| **w == why).count()
    }

    /// Tokens written, not removed, discarded or excused, and absent from
    /// `present`.
    pub fn lost(&self, present: &BTreeSet<String>) -> Vec<String> {
        self.written
            .keys()
            .filter(|t| {
                !present.contains(*t)
                    && !self.removed.contains(*t)
                    && !self.discarded.contains(*t)
                    && !self.excused.contains_key(*t)
            })
            .cloned()
            .collect()
    }
}

/// Tokens are zero-padded to at least this many digits, and a match needs as
/// many: `tk7x` is four bytes, which real ciphertext produces by chance (seen
/// once per ~1000-seed real-service sweep); `tk000007x` is nine.
pub const TOKEN_DIGITS: usize = 6;

/// Every token `tk<N>x` in `text` (`N` at least [`TOKEN_DIGITS`] digits).
pub fn tokens_in(text: &[u8]) -> Vec<String> {
    let b = text;
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < b.len() {
        if b[i] == b't' && b[i + 1] == b'k' && b[i + 2].is_ascii_digit() {
            let mut j = i + 2;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j < b.len() && b[j] == b'x' && j - (i + 2) >= TOKEN_DIGITS {
                out.push(String::from_utf8_lossy(&b[i..=j]).into_owned());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// A write a client saw acknowledged as durably confirmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ack {
    /// Mutation ID (hex or text).
    pub mutation: String,
    /// Confirmed at this log position.
    pub seq: u64,
    /// Tokens the write carried.
    pub tokens: Vec<String>,
    /// Who saw the ack.
    pub client: String,
    /// When, ms since start.
    pub at: u64,
}

/// The acknowledged-writes ledger.
#[derive(Debug, Default, Clone)]
pub struct AckLedger {
    /// By mutation ID.
    pub acks: BTreeMap<String, Ack>,
    /// Acks that disagreed with an earlier ack of the same mutation.
    pub conflicts: Vec<String>,
}

impl AckLedger {
    /// Record an ack.
    pub fn ack(&mut self, a: Ack) {
        if let Some(prev) = self.acks.get(&a.mutation) {
            if prev.seq != a.seq {
                self.conflicts.push(format!(
                    "mutation {} acked at seq {} and at seq {}",
                    a.mutation, prev.seq, a.seq
                ));
            }
            return;
        }
        self.acks.insert(a.mutation.clone(), a);
    }

    /// A fallback relocation (receipt `relocated_from`): the ack moves from `from`
    /// to `to` only if it was recorded at `from`. Returns whether it moved.
    pub fn relocate(&mut self, mutation: &str, from: u64, to: u64) -> bool {
        match self.acks.get_mut(mutation) {
            Some(a) if a.seq == from => {
                a.seq = to;
                true
            }
            Some(a) => {
                self.conflicts.push(format!(
                    "mutation {mutation} relocated from {from} to {to}, but it was acked at {}",
                    a.seq
                ));
                false
            }
            None => false,
        }
    }

    /// Check against the final log: `at_seq(s)` gives the mutation IDs the log holds
    /// at position `s` (empty if the position is missing or holds something else).
    pub fn check(&self, at_seq: impl Fn(u64) -> Vec<String>) -> Vec<Violation> {
        let mut v: Vec<Violation> = self
            .conflicts
            .iter()
            .map(|c| Violation {
                kind: Kind::LostAck,
                detail: c.clone(),
            })
            .collect();
        for a in self.acks.values() {
            if !at_seq(a.seq).contains(&a.mutation) {
                v.push(Violation {
                    kind: Kind::LostAck,
                    detail: format!(
                        "{} acked to {} at t={} as seq {}, but the final log holds {:?} there",
                        a.mutation,
                        a.client,
                        a.at,
                        a.seq,
                        at_seq(a.seq)
                    ),
                });
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_roundtrip() {
        let mut t = Tokens::default();
        let a = t.fresh("ed");
        let b = t.fresh("ed");
        let text = format!("x {a} y{b}z tk12 tkx");
        assert_eq!(tokens_in(text.as_bytes()), vec![a.clone(), b.clone()]);
        let present: BTreeSet<String> = [a].into_iter().collect();
        assert_eq!(t.lost(&present), vec![b.clone()]);
        t.excuse(&b, "power");
        assert!(t.lost(&present).is_empty());
    }

    /// Sealed bytes observed in CI (slice-real seed 80, item 130): `tk7x` sits in
    /// the ciphertext by chance. Short runs are not tokens; the padded form is.
    #[test]
    fn short_runs_in_ciphertext_are_not_tokens() {
        let window = b"\x8a\x12\xf0\xad\x41\xec\x64\x7c\xc9\x64\x7e\xbbtk7x\xb0\x11\xab\x7f\xbc\xc6\x0d\xd6\x1e\x0d";
        assert!(tokens_in(window).is_empty());
        let mut t = Tokens::default();
        for _ in 0..7 {
            t.fresh("ed");
        }
        assert_eq!(
            tokens_in(b"see tk000007x here"),
            vec!["tk000007x".to_string()]
        );
        assert!(t.written.contains_key("tk000007x"));
        assert!(
            tokens_in(b"tk00007x").is_empty(),
            "five digits is too short"
        );
    }
}
