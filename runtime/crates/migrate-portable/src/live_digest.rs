//! The live-state digest both sides of a hosted import compute, so the shadow
//! compare and the post-replay check at barrier F stream instead of
//! holding a collection.
//!
//! **What it covers.** The *live* namespace as a user sees it: every resource (path,
//! content hash), every record (ID, path, revision, size) and every file (ID, path,
//! content hash, size, kind: ordinary attachment or unindexed oversized Markdown),
//! after the import's renames. Tombstones, receipts, conflicts and log positions are
//! deliberately absent: the legacy side has no new-log sequence numbers, and the
//! replica's own `state_digest` already binds those inside the new system.
//!
//! **How.** Order-independent and windowed, so each side can feed rows in whatever
//! order its storage pages them (legacy primary keys; Durable Object buckets):
//! - an entity's element is two domain-separated SHA-256 hashes of its canonical
//!   encoding, read as one 512-bit number;
//! - its window is the first byte of `SHA-256(id)` (the top byte of the replica's
//!   `bucket16`, so the DO side can rescan one window by bucket), or of the path
//!   hash for resources;
//! - each window keeps the sum of its elements modulo 2^512 and a count.
//!
//! [`LiveDigest::digest`] binds every window and count. Equal digests mean equal
//! live state up to a 512-bit sum collision; that is a check against import bugs,
//! not an authenticator (the replica's signed manifest and log are). On a
//! mismatch, [`LiveDigest::differing_windows`] names the windows to rescan on both
//! sides, a bounded diff. The state is 256 × 72 bytes and serializes
//! ([`LiveDigest::to_bytes`]) for a metadata-only checkpoint between requests.
//!
//! Nothing here sees document or attachment bytes: callers pass hashes and sizes.

use mdbn_wire::common::{Hash, Uuid};

use crate::{Error, Result};

/// Windows per digest: the top byte of the bucket.
pub const WINDOWS: usize = 256;

const LIMBS: usize = 8;
const STATE_BYTES: usize = 8 + WINDOWS * (8 + LIMBS * 8);

/// The kind of a live file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    /// An ordinary attachment (`AttachmentV1`).
    Attachment,
    /// A Markdown document too large to index (`UnindexedOversizedMarkdown`).
    UnindexedMarkdown,
}

/// One live entity, as both sides describe it. Hashes and sizes only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Live<'a> {
    /// A resource by path.
    Resource {
        /// Collection-relative path after renames.
        path: &'a str,
        /// SHA-256 of its text.
        content: Hash,
    },
    /// A record.
    Record {
        /// The record ID (the legacy ID).
        id: Uuid,
        /// Path after renames.
        path: &'a str,
        /// SHA-256 of the exact document.
        revision: Hash,
        /// Document size in bytes.
        size: u64,
    },
    /// A file.
    File {
        /// The file ID (the legacy file ID, or the record ID of an oversized document).
        id: Uuid,
        /// Path after renames.
        path: &'a str,
        /// SHA-256 of the whole plaintext.
        content: Hash,
        /// Plaintext size in bytes.
        size: u64,
        /// Its kind.
        kind: FileKind,
    },
}

impl Live<'_> {
    fn window(&self) -> usize {
        match self {
            Live::Resource { path, .. } => mdbn_wire::hash::sha256(path.as_bytes()).0[0] as usize,
            Live::Record { id, .. } | Live::File { id, .. } => window_of(id),
        }
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(96);
        let text = |out: &mut Vec<u8>, s: &str| {
            out.extend_from_slice(&(s.len() as u64).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
        };
        match self {
            Live::Resource { path, content } => {
                out.push(0);
                text(&mut out, path);
                out.extend_from_slice(&content.0);
            }
            Live::Record {
                id,
                path,
                revision,
                size,
            } => {
                out.push(1);
                out.extend_from_slice(&id.0);
                text(&mut out, path);
                out.extend_from_slice(&revision.0);
                out.extend_from_slice(&size.to_be_bytes());
            }
            Live::File {
                id,
                path,
                content,
                size,
                kind,
            } => {
                out.push(match kind {
                    FileKind::Attachment => 2,
                    FileKind::UnindexedMarkdown => 3,
                });
                out.extend_from_slice(&id.0);
                text(&mut out, path);
                out.extend_from_slice(&content.0);
                out.extend_from_slice(&size.to_be_bytes());
            }
        }
        out
    }

    fn element(&self) -> [u64; LIMBS] {
        let enc = self.encode();
        let a = mdbn_wire::hash::h("mdbase/v1/migrate/live-a", &enc);
        let b = mdbn_wire::hash::h("mdbase/v1/migrate/live-b", &enc);
        let mut limbs = [0u64; LIMBS];
        for (i, chunk) in a.0.chunks(8).chain(b.0.chunks(8)).enumerate() {
            limbs[i] = u64::from_be_bytes(chunk.try_into().unwrap_or([0; 8]));
        }
        limbs
    }
}

/// The window of an entity ID: the top byte of the replica's `bucket16`.
pub fn window_of(id: &Uuid) -> usize {
    mdbn_wire::hash::sha256(&id.0).0[0] as usize
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Window {
    count: u64,
    sum: [u64; LIMBS],
}

/// The accumulator. See the module docs.
#[derive(Clone, PartialEq, Eq)]
pub struct LiveDigest {
    total: u64,
    windows: Vec<Window>,
}

impl std::fmt::Debug for LiveDigest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveDigest")
            .field("total", &self.total)
            .finish_non_exhaustive()
    }
}

impl Default for LiveDigest {
    fn default() -> Self {
        Self {
            total: 0,
            windows: vec![
                Window {
                    count: 0,
                    sum: [0; LIMBS],
                };
                WINDOWS
            ],
        }
    }
}

impl LiveDigest {
    /// An empty digest.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add one live entity. Order does not matter.
    pub fn add(&mut self, e: &Live<'_>) {
        let w = &mut self.windows[e.window()];
        add_limbs(&mut w.sum, &e.element());
        w.count += 1;
        self.total += 1;
    }

    /// Entities added.
    pub fn total(&self) -> u64 {
        self.total
    }

    /// The digest of the whole live state.
    pub fn digest(&self) -> Hash {
        mdbn_wire::hash::h("mdbase/v1/migrate/live-digest", &self.to_bytes())
    }

    /// The digest of one window.
    pub fn window_digest(&self, window: usize) -> Option<Hash> {
        let w = self.windows.get(window)?;
        let mut m = Vec::with_capacity(8 + LIMBS * 8 + 2);
        m.extend_from_slice(&(window as u16).to_be_bytes());
        m.extend_from_slice(&w.count.to_be_bytes());
        for l in w.sum {
            m.extend_from_slice(&l.to_be_bytes());
        }
        Some(mdbn_wire::hash::h("mdbase/v1/migrate/live-window", &m))
    }

    /// The windows where `self` and `other` differ, ascending: rescan only these.
    pub fn differing_windows(&self, other: &LiveDigest) -> Vec<usize> {
        (0..WINDOWS)
            .filter(|&i| self.windows[i] != other.windows[i])
            .collect()
    }

    /// Fold in another partial digest (e.g. one computed per page or per worker).
    pub fn merge(&mut self, other: &LiveDigest) {
        for (a, b) in self.windows.iter_mut().zip(&other.windows) {
            add_limbs(&mut a.sum, &b.sum);
            a.count += b.count;
        }
        self.total += other.total;
    }

    /// A fixed-size encoding for a metadata-only checkpoint.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(STATE_BYTES);
        out.extend_from_slice(&self.total.to_be_bytes());
        for w in &self.windows {
            out.extend_from_slice(&w.count.to_be_bytes());
            for l in w.sum {
                out.extend_from_slice(&l.to_be_bytes());
            }
        }
        out
    }

    /// Decode [`Self::to_bytes`]. Refuses a wrong length or inconsistent counts.
    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        if b.len() != STATE_BYTES {
            return Err(Error::Invalid("live digest state: wrong length".into()));
        }
        let u = |i: usize| u64::from_be_bytes(b[i..i + 8].try_into().unwrap_or([0; 8]));
        let mut d = LiveDigest {
            total: u(0),
            ..LiveDigest::default()
        };
        let mut at = 8;
        let mut counted = 0u64;
        for w in &mut d.windows {
            w.count = u(at);
            at += 8;
            for l in &mut w.sum {
                *l = u(at);
                at += 8;
            }
            counted = counted
                .checked_add(w.count)
                .ok_or_else(|| Error::Invalid("live digest state: count overflow".into()))?;
        }
        if counted != d.total {
            return Err(Error::Invalid("live digest state: counts disagree".into()));
        }
        Ok(d)
    }
}

/// `a += b` modulo 2^512, big-endian limbs.
fn add_limbs(a: &mut [u64; LIMBS], b: &[u64; LIMBS]) {
    let mut carry = 0u64;
    for i in (0..LIMBS).rev() {
        let (s1, c1) = a[i].overflowing_add(b[i]);
        let (s2, c2) = s1.overflowing_add(carry);
        a[i] = s2;
        carry = u64::from(c1) + u64::from(c2);
    }
}

/// The ID of a 16-byte wire UUID, for callers holding text IDs.
pub fn id(s: &str) -> Result<Uuid> {
    crate::ids::uuid(s)
}

/// A content hash from the legacy `sha256:<hex>` form.
pub fn content(s: &str) -> Result<Hash> {
    crate::ids::revision(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::{B16, B32};

    fn rec(i: u8, path: &str) -> (Uuid, String, Hash) {
        (B16([i; 16]), path.to_owned(), mdbn_wire::hash::sha256(&[i]))
    }

    fn feed(d: &mut LiveDigest, rows: &[(Uuid, String, Hash)]) {
        for (id, path, rev) in rows {
            d.add(&Live::Record {
                id: *id,
                path,
                revision: *rev,
                size: 1,
            });
        }
    }

    #[test]
    fn order_and_paging_do_not_matter() {
        let rows: Vec<_> = (0..200u8).map(|i| rec(i, &format!("n/{i}.md"))).collect();
        let mut a = LiveDigest::new();
        feed(&mut a, &rows);
        let mut rev = rows.clone();
        rev.reverse();
        let mut b = LiveDigest::new();
        feed(&mut b, &rev[..100]);
        let mut c = LiveDigest::new();
        feed(&mut c, &rev[100..]);
        b.merge(&c);
        assert_eq!(a.digest(), b.digest());
        assert_eq!(a.total(), 200);
        assert!(a.differing_windows(&b).is_empty());
    }

    #[test]
    fn any_change_moves_the_digest_and_names_its_window() {
        let rows: Vec<_> = (0..50u8).map(|i| rec(i, &format!("n/{i}.md"))).collect();
        let mut a = LiveDigest::new();
        feed(&mut a, &rows);
        let mut changed = rows.clone();
        changed[7].1 = "n/renamed.md".into();
        let mut b = LiveDigest::new();
        feed(&mut b, &changed);
        assert_ne!(a.digest(), b.digest());
        assert_eq!(a.differing_windows(&b), vec![window_of(&rows[7].0)]);

        // A missing entity, a duplicated one, and a kind change all differ.
        let mut c = LiveDigest::new();
        feed(&mut c, &rows[1..]);
        assert_ne!(a.digest(), c.digest());
        let mut d = a.clone();
        feed(&mut d, &rows[..1]);
        assert_ne!(a.digest(), d.digest());
        let file = |kind| Live::File {
            id: B16([1; 16]),
            path: "big.md",
            content: B32([2; 32]),
            size: 2 << 20,
            kind,
        };
        let mut e = LiveDigest::new();
        e.add(&file(FileKind::Attachment));
        let mut f = LiveDigest::new();
        f.add(&file(FileKind::UnindexedMarkdown));
        assert_ne!(e.digest(), f.digest());
        // A record and a file with the same fields are different entities.
        let mut g = LiveDigest::new();
        g.add(&Live::Record {
            id: B16([1; 16]),
            path: "big.md",
            revision: B32([2; 32]),
            size: 2 << 20,
        });
        assert_ne!(e.digest(), g.digest());
    }

    #[test]
    fn state_round_trips_and_refuses_corruption() {
        let mut a = LiveDigest::new();
        feed(&mut a, &[rec(1, "a.md"), rec(2, "b.md")]);
        a.add(&Live::Resource {
            path: "mdbase.yaml",
            content: B32([9; 32]),
        });
        let bytes = a.to_bytes();
        assert_eq!(bytes.len(), STATE_BYTES);
        assert_eq!(LiveDigest::from_bytes(&bytes).unwrap(), a);
        let mut bad = bytes.clone();
        bad[7] ^= 1;
        assert!(LiveDigest::from_bytes(&bad).is_err());
        assert!(LiveDigest::from_bytes(&bytes[1..]).is_err());
        assert!(!format!("{a:?}").contains(".md"));
    }

    #[test]
    fn sums_carry_across_limbs() {
        let mut a = [u64::MAX; LIMBS];
        add_limbs(&mut a, &[0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(a, [0; LIMBS], "wraps modulo 2^512");
    }
}
