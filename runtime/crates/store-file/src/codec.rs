//! Encoding of the file store's own rows (CBOR arrays, `mdbn_wire::cbor`).

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B32, Hash, Uuid};

use crate::platform::{FileId, RelPath, ReplaceStrategy};
use crate::publish::{Expect, Names, PublishOp, Retained};

/// What the store last knew to be at a path.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DiskState {
    /// Record, file or resource ID, when known.
    pub id: Option<Uuid>,
    /// Revision of the bytes.
    pub rev: Hash,
    /// Size.
    pub size: u64,
    /// Modification time.
    pub mtime_ns: i64,
    /// Status-change time, if the platform has one.
    pub ctime_ns: Option<i64>,
    /// File identity, if the platform has one.
    pub file_id: Option<FileId>,
    /// We wrote these bytes (vs. observed them).
    pub ours: bool,
}

/// A journaled publish intent plus what the store needs after recovery.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct IntentRec {
    /// The strategy used.
    pub strategy: ReplaceStrategy,
    /// The operation.
    pub op: PublishOp,
    /// Name counter value (names derive from it).
    pub n: u64,
    /// The ID the path belongs to.
    pub id: Option<Uuid>,
    /// The journaled retained-directory choice; legacy intents use stash.
    pub retained_nosync: bool,
}

impl IntentRec {
    /// The private names of this intent.
    pub fn names(&self, private_dir: &RelPath) -> Names {
        Names::for_retention(private_dir, self.n, self.retained_nosync)
    }
}

/// A retained file and when it was retained.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RetainedRec {
    /// The file.
    pub r: Retained,
    /// The user path it was displaced from.
    pub user_path: String,
    /// When (ms).
    pub since: u64,
    /// The persisted store-open session; legacy rows use zero.
    pub session: u64,
    /// Actual retained-file size when available; unknown is never zero.
    pub size: Option<u64>,
    /// The ID the user path belongs to.
    pub id: Option<Uuid>,
}

/// An observation whose evidence is a private file (a preserved user version).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EvidenceRec {
    /// The user path it belongs to.
    pub path: String,
    /// The private file holding the bytes.
    pub evidence: RelPath,
    /// The base the bytes are an edit on.
    pub base: Option<Hash>,
    /// Came from crash recovery (provenance unknown).
    pub suspect: bool,
}

fn u(v: u64) -> Cbor {
    Cbor::Uint(v)
}

fn i(v: i64) -> Cbor {
    if v >= 0 {
        Cbor::Uint(v as u64)
    } else {
        Cbor::Nint((-1 - v) as u64)
    }
}

fn opt(c: Option<Cbor>) -> Cbor {
    c.unwrap_or(Cbor::Null)
}

fn hash(h: &Hash) -> Cbor {
    Cbor::Bytes(h.0.to_vec())
}

fn text(s: &str) -> Cbor {
    Cbor::Text(s.to_string())
}

fn enc(c: Cbor) -> Vec<u8> {
    // Values built here are always encodable (no floats).
    cbor::encode(&c).unwrap_or_default()
}

fn dec(b: &[u8]) -> Option<Vec<Cbor>> {
    match cbor::decode(b).ok()? {
        Cbor::Array(a) => Some(a),
        _ => None,
    }
}

fn get_u(c: &Cbor) -> Option<u64> {
    match c {
        Cbor::Uint(v) => Some(*v),
        _ => None,
    }
}

fn get_i(c: &Cbor) -> Option<i64> {
    match c {
        Cbor::Uint(v) => i64::try_from(*v).ok(),
        Cbor::Nint(v) => i64::try_from(*v).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn get_bytes(c: &Cbor) -> Option<&[u8]> {
    match c {
        Cbor::Bytes(b) => Some(b),
        _ => None,
    }
}

fn get_hash(c: &Cbor) -> Option<Hash> {
    Some(B32(get_bytes(c)?.try_into().ok()?))
}

fn get_text(c: &Cbor) -> Option<&str> {
    match c {
        Cbor::Text(s) => Some(s),
        _ => None,
    }
}

fn get_uuid(c: &Cbor) -> Option<Option<Uuid>> {
    match c {
        Cbor::Null => Some(None),
        Cbor::Bytes(b) => Some(Some(mdbn_wire::common::B16(b.as_slice().try_into().ok()?))),
        _ => None,
    }
}

fn uuid(id: &Option<Uuid>) -> Cbor {
    opt(id.map(|x| Cbor::Bytes(x.0.to_vec())))
}

fn get_bool(c: &Cbor) -> Option<bool> {
    match c {
        Cbor::Bool(b) => Some(*b),
        _ => None,
    }
}

fn get_relpath(c: &Cbor) -> Option<RelPath> {
    RelPath::new(get_text(c)?).ok()
}

fn strategy_code(s: ReplaceStrategy) -> u64 {
    match s {
        ReplaceStrategy::Exchange => 0,
        ReplaceStrategy::LockedInPlace => 1,
        ReplaceStrategy::GuardedInPlace => 2,
        ReplaceStrategy::ReadOnly => 3,
    }
}

fn strategy_of(v: u64) -> Option<ReplaceStrategy> {
    Some(match v {
        0 => ReplaceStrategy::Exchange,
        1 => ReplaceStrategy::LockedInPlace,
        2 => ReplaceStrategy::GuardedInPlace,
        3 => ReplaceStrategy::ReadOnly,
        _ => return None,
    })
}

impl DiskState {
    /// Encode.
    pub fn to_bytes(&self) -> Vec<u8> {
        enc(Cbor::Array(vec![
            uuid(&self.id),
            hash(&self.rev),
            u(self.size),
            i(self.mtime_ns),
            opt(self.ctime_ns.map(i)),
            opt(self
                .file_id
                .map(|f| Cbor::Bytes(f.0.to_be_bytes().to_vec()))),
            Cbor::Bool(self.ours),
        ]))
    }

    /// Decode.
    pub fn from_bytes(b: &[u8]) -> Option<DiskState> {
        let a = dec(b)?;
        let [id, rev, size, mtime, ctime, fid, ours] = a.as_slice() else {
            return None;
        };
        Some(DiskState {
            id: get_uuid(id)?,
            rev: get_hash(rev)?,
            size: get_u(size)?,
            mtime_ns: get_i(mtime)?,
            ctime_ns: match ctime {
                Cbor::Null => None,
                c => Some(get_i(c)?),
            },
            file_id: match fid {
                Cbor::Null => None,
                c => Some(FileId(u128::from_be_bytes(get_bytes(c)?.try_into().ok()?))),
            },
            ours: get_bool(ours)?,
        })
    }
}

impl IntentRec {
    /// Encode.
    pub fn to_bytes(&self) -> Vec<u8> {
        let expect = match &self.op.expect {
            Expect::Absent => Cbor::Array(vec![u(0)]),
            Expect::Rev(h) => Cbor::Array(vec![u(1), hash(h)]),
            Expect::Bytes(b) => Cbor::Array(vec![u(2), Cbor::Bytes(b.clone())]),
        };
        enc(Cbor::Array(vec![
            u(strategy_code(self.strategy)),
            text(self.op.path.as_str()),
            expect,
            opt(self.op.new.clone().map(Cbor::Bytes)),
            u(self.n),
            uuid(&self.id),
            Cbor::Bool(self.retained_nosync),
        ]))
    }

    /// Decode.
    pub fn from_bytes(b: &[u8]) -> Option<IntentRec> {
        let a = dec(b)?;
        let (s, path, expect, new, n, id, retained_nosync) = match a.as_slice() {
            [s, path, expect, new, n, id] => (s, path, expect, new, n, id, false),
            [s, path, expect, new, n, id, nosync] => {
                (s, path, expect, new, n, id, get_bool(nosync)?)
            }
            _ => return None,
        };
        let expect = match expect {
            Cbor::Array(e) => match e.as_slice() {
                [t] if get_u(t)? == 0 => Expect::Absent,
                [t, h] if get_u(t)? == 1 => Expect::Rev(get_hash(h)?),
                [t, b] if get_u(t)? == 2 => Expect::Bytes(get_bytes(b)?.to_vec()),
                _ => return None,
            },
            _ => return None,
        };
        Some(IntentRec {
            strategy: strategy_of(get_u(s)?)?,
            op: PublishOp {
                path: get_relpath(path)?,
                expect,
                new: match new {
                    Cbor::Null => None,
                    c => Some(get_bytes(c)?.to_vec()),
                },
            },
            n: get_u(n)?,
            id: get_uuid(id)?,
            retained_nosync,
        })
    }
}

impl RetainedRec {
    /// Encode.
    pub fn to_bytes(&self) -> Vec<u8> {
        enc(Cbor::Array(vec![
            text(self.r.path.as_str()),
            hash(&self.r.expect),
            text(&self.user_path),
            u(self.since),
            uuid(&self.id),
            u(self.session),
            opt(self.size.map(u)),
        ]))
    }

    /// Decode both legacy five-field rows and the seven-field extension.
    pub fn from_bytes(b: &[u8]) -> Option<RetainedRec> {
        let a = dec(b)?;
        let (p, e, up, since, id, session, size) = match a.as_slice() {
            [p, e, up, since, id] => (p, e, up, since, id, 0, None),
            [p, e, up, since, id, session, size] => (
                p,
                e,
                up,
                since,
                id,
                get_u(session)?,
                match size {
                    Cbor::Null => None,
                    c => Some(get_u(c)?),
                },
            ),
            _ => return None,
        };
        Some(RetainedRec {
            r: Retained {
                path: get_relpath(p)?,
                expect: get_hash(e)?,
            },
            user_path: get_text(up)?.to_string(),
            since: get_u(since)?,
            session,
            size,
            id: get_uuid(id)?,
        })
    }
}

impl EvidenceRec {
    /// Encode.
    pub fn to_bytes(&self) -> Vec<u8> {
        enc(Cbor::Array(vec![
            text(&self.path),
            text(self.evidence.as_str()),
            opt(self.base.as_ref().map(hash)),
            Cbor::Bool(self.suspect),
        ]))
    }

    /// Decode.
    pub fn from_bytes(b: &[u8]) -> Option<EvidenceRec> {
        let a = dec(b)?;
        let [p, e, base, s] = a.as_slice() else {
            return None;
        };
        Some(EvidenceRec {
            path: get_text(p)?.to_string(),
            evidence: get_relpath(e)?,
            base: match base {
                Cbor::Null => None,
                c => Some(get_hash(c)?),
            },
            suspect: get_bool(s)?,
        })
    }
}

/// Encode a counter value.
pub fn counter_bytes(v: u64) -> Vec<u8> {
    v.to_be_bytes().to_vec()
}

/// Decode a counter value.
pub fn counter_of(b: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(b.try_into().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips() {
        let d = DiskState {
            id: Some(mdbn_wire::common::B16([7; 16])),
            rev: B32([1; 32]),
            size: 12,
            mtime_ns: -5,
            ctime_ns: Some(9),
            file_id: Some(FileId(u128::MAX - 3)),
            ours: true,
        };
        assert_eq!(DiskState::from_bytes(&d.to_bytes()), Some(d));
        for expect in [
            Expect::Absent,
            Expect::Rev(B32([2; 32])),
            Expect::Bytes(b"x".to_vec()),
        ] {
            let it = IntentRec {
                strategy: ReplaceStrategy::LockedInPlace,
                op: PublishOp {
                    path: RelPath::new("a/b.md").unwrap(),
                    expect,
                    new: Some(b"new".to_vec()),
                },
                n: 42,
                id: None,
                retained_nosync: true,
            };
            assert_eq!(IntentRec::from_bytes(&it.to_bytes()), Some(it.clone()));
            let private = RelPath::new(".mdbase").unwrap();
            assert_eq!(
                it.names(&private).stash.as_str(),
                ".mdbase/retained.nosync/42"
            );
            let mut fields = dec(&it.to_bytes()).unwrap();
            fields.truncate(6);
            let legacy = IntentRec::from_bytes(&enc(Cbor::Array(fields.clone()))).unwrap();
            assert!(!legacy.retained_nosync);
            assert_eq!(legacy.op, it.op);
            assert_eq!(legacy.names(&private).stash.as_str(), ".mdbase/stash/42");
            fields.push(Cbor::Uint(1));
            assert!(IntentRec::from_bytes(&enc(Cbor::Array(fields))).is_none());
        }
        let r = RetainedRec {
            r: Retained {
                path: RelPath::new(".mdbase/stash/3").unwrap(),
                expect: B32([4; 32]),
            },
            user_path: "a.md".into(),
            since: 77,
            session: u64::MAX,
            size: Some(u64::MAX),
            id: None,
        };
        assert_eq!(RetainedRec::from_bytes(&r.to_bytes()), Some(r.clone()));
        let mut fields = dec(&r.to_bytes()).unwrap();
        fields.truncate(5);
        let legacy = RetainedRec::from_bytes(&enc(Cbor::Array(fields.clone()))).unwrap();
        assert_eq!(legacy.session, 0);
        assert_eq!(legacy.size, None);
        assert_eq!(legacy.r, r.r);
        assert_eq!(legacy.user_path, r.user_path);
        fields.push(Cbor::Uint(1));
        assert!(RetainedRec::from_bytes(&enc(Cbor::Array(fields))).is_none());
        let e = EvidenceRec {
            path: "a.md".into(),
            evidence: RelPath::new(".mdbase/held/3").unwrap(),
            base: None,
            suspect: true,
        };
        assert_eq!(EvidenceRec::from_bytes(&e.to_bytes()), Some(e));
    }
}
