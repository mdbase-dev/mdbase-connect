//! Canonical CBOR for [`Action`] and [`Outcome`]: the boundary between the driver
//! in the hosted Worker's WASM and its TypeScript host.
//!
//! Every value is an array whose first element is a numeric tag and whose other
//! elements are positional fields (`null` for an absent option). Hashes and IDs
//! are byte strings of their exact length. Decoding refuses anything else, so a
//! host bug can never be read as a different outcome.

use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32};

use super::{Action, Batch, Class, Effect, Generation, Key, Meta, Outcome, SourceRow, Step, Table};
use crate::preflight::EntityKind;
use crate::{Error, Result};

fn bad(what: &str) -> Error {
    Error::Invalid(format!("codec: {what}"))
}

// ---------------------------------------------------------------- encode helpers

fn u(v: u64) -> Cbor {
    Cbor::Uint(v)
}
fn t(s: &str) -> Cbor {
    Cbor::Text(s.to_owned())
}
fn opt<T>(v: Option<T>, f: impl FnOnce(T) -> Cbor) -> Cbor {
    v.map_or(Cbor::Null, f)
}
fn key(k: &Key) -> Cbor {
    Cbor::Array(vec![u(k.kind as u64), t(&k.id)])
}
fn class(c: Class) -> u64 {
    match c {
        Class::Resource => 0,
        Class::Record => 1,
        Class::Attachment => 2,
        Class::UnindexedMarkdown => 3,
    }
}
fn meta(m: &Meta) -> Cbor {
    Cbor::Array(vec![
        u(class(m.class)),
        t(&m.path),
        Cbor::Bytes(m.content.0.to_vec()),
        u(m.size),
    ])
}
fn generation(g: Generation) -> u64 {
    match g {
        Generation::S0 => 0,
        Generation::Final => 1,
    }
}
fn table(tb: Table) -> u64 {
    match tb {
        Table::Resources => 0,
        Table::Records => 1,
        Table::Files => 2,
    }
}
fn effect(e: &Effect) -> Cbor {
    match e {
        Effect::Delete { key: k, from } => Cbor::Array(vec![u(0), key(k), meta(from)]),
        Effect::Park { key: k, from, to } => Cbor::Array(vec![u(1), key(k), meta(from), t(to)]),
        Effect::Put { key: k, from, to } => {
            Cbor::Array(vec![u(2), key(k), opt(from.as_ref(), meta), meta(to)])
        }
    }
}
fn batch(b: &Batch) -> Cbor {
    Cbor::Array(vec![
        Cbor::Bytes(b.mutation.0.to_vec()),
        u(b.pass),
        u(b.s_final),
        Cbor::Array(b.effects.iter().map(effect).collect()),
        key(&b.last),
    ])
}
fn ids(v: &[String]) -> Cbor {
    Cbor::Array(v.iter().map(|s| t(s)).collect())
}
fn tagged(tag: u64, mut rest: Vec<Cbor>) -> Cbor {
    rest.insert(0, u(tag));
    Cbor::Array(rest)
}

/// The canonical bytes of an action.
pub fn encode_action(a: &Action) -> Result<Vec<u8>> {
    use Action::*;
    let c = match a {
        EnsureBackup => tagged(0, vec![]),
        CreateCollection => tagged(1, vec![]),
        OpenSource {
            generation: g,
            expect_head,
        } => tagged(2, vec![u(generation(*g)), opt(*expect_head, u)]),
        ReadPage {
            generation: g,
            table: tb,
            cursor,
            max_rows,
            max_bytes,
        } => tagged(
            3,
            vec![
                u(generation(*g)),
                u(table(*tb)),
                opt(cursor.as_deref(), t),
                u(*max_rows as u64),
                u(*max_bytes as u64),
            ],
        ),
        ImportGen0 {
            bits,
            bucket,
            after,
        } => tagged(4, vec![u(*bits), opt(*bucket, u), opt(after.as_ref(), key)]),
        FinishGen0 => tagged(5, vec![]),
        AppendBase {
            manifest,
            state_digest,
        } => tagged(
            6,
            vec![
                Cbor::Bytes(manifest.0.to_vec()),
                Cbor::Bytes(state_digest.0.to_vec()),
            ],
        ),
        FindBase => tagged(7, vec![]),
        Rebuild { at_least } => tagged(8, vec![u(*at_least)]),
        ReadNew { cursor } => tagged(9, vec![opt(cursor.as_deref(), t)]),
        MayFence => tagged(10, vec![]),
        Fence => tagged(11, vec![]),
        DrainStatus => tagged(12, vec![]),
        ListReplicas => tagged(13, vec![]),
        RevokeReplicas { ids: v } => tagged(14, vec![ids(v)]),
        AppendCutover { s_final } => tagged(15, vec![u(*s_final)]),
        FindCutover => tagged(16, vec![]),
        Replay(b) => tagged(17, vec![batch(b)]),
        FindMutation { mutation } => tagged(18, vec![Cbor::Bytes(mutation.0.to_vec())]),
        LogHead => tagged(19, vec![]),
        Route {
            s_final,
            cutover_seq,
            barrier_f,
            final_digest,
        } => tagged(
            20,
            vec![
                u(*s_final),
                u(*cutover_seq),
                u(*barrier_f),
                Cbor::Bytes(final_digest.0.to_vec()),
            ],
        ),
        Unrevoke { ids: v } => tagged(21, vec![ids(v)]),
        Unfence => tagged(22, vec![]),
        Wait(w) => tagged(
            23,
            vec![u(match w {
                super::Wait::Paused => 0,
                super::Wait::Draining => 1,
                super::Wait::Keying => 2,
            })],
        ),
        Continue => tagged(24, vec![]),
        Done(s) => tagged(25, vec![u(*s as u64)]),
    };
    cbor::encode(&c).map_err(|e| bad(&format!("{e:?}")))
}

/// The canonical bytes of an outcome.
pub fn encode_outcome(o: &Outcome) -> Result<Vec<u8>> {
    use Outcome::*;
    let c = match o {
        Ok => tagged(0, vec![]),
        Backup { hold } => tagged(1, vec![t(hold)]),
        Created { verified } => tagged(2, vec![Cbor::Bool(*verified)]),
        Opened { head } => tagged(3, vec![u(*head)]),
        Page { rows, next } => tagged(
            4,
            vec![
                Cbor::Array(
                    rows.iter()
                        .map(|r| {
                            Cbor::Array(vec![
                                opt(r.id.as_deref(), t),
                                t(&r.path),
                                Cbor::Bytes(r.content.0.to_vec()),
                                u(r.size),
                            ])
                        })
                        .collect(),
                ),
                opt(next.as_deref(), t),
            ],
        ),
        Gen0Progress { last, done } => tagged(5, vec![opt(last.as_ref(), key), Cbor::Bool(*done)]),
        Gen0Built {
            manifest,
            state_digest,
        } => tagged(
            6,
            vec![
                Cbor::Bytes(manifest.0.to_vec()),
                Cbor::Bytes(state_digest.0.to_vec()),
            ],
        ),
        Appended { seq } => tagged(7, vec![u(*seq)]),
        Unknown => tagged(8, vec![]),
        Conflict => tagged(9, vec![]),
        Stale => tagged(10, vec![]),
        Found { seq } => tagged(11, vec![opt(*seq, u)]),
        Rebuilt { head } => tagged(12, vec![u(*head)]),
        NewPage { rows, next } => tagged(
            13,
            vec![
                Cbor::Array(
                    rows.iter()
                        .map(|(k, m)| Cbor::Array(vec![key(k), meta(m)]))
                        .collect(),
                ),
                opt(next.as_deref(), t),
            ],
        ),
        MayFence(b) => tagged(14, vec![Cbor::Bool(*b)]),
        Drain { pending, head } => tagged(15, vec![u(*pending), u(*head)]),
        Replicas { ids: v } => tagged(16, vec![ids(v)]),
        Head { seq } => tagged(17, vec![u(*seq)]),
        Gone => tagged(18, vec![]),
        Failed { transient, reason } => tagged(19, vec![Cbor::Bool(*transient), t(reason)]),
    };
    cbor::encode(&c).map_err(|e| bad(&format!("{e:?}")))
}

// ---------------------------------------------------------------- decode helpers

struct Fields<'a> {
    v: &'a [Cbor],
    i: usize,
}

impl<'a> Fields<'a> {
    fn of(c: &'a Cbor) -> Result<(u64, Fields<'a>)> {
        let Cbor::Array(v) = c else {
            return Err(bad("not an array"));
        };
        let Some(Cbor::Uint(tag)) = v.first() else {
            return Err(bad("no tag"));
        };
        Ok((*tag, Fields { v, i: 1 }))
    }
    fn next(&mut self) -> Result<&'a Cbor> {
        let c = self.v.get(self.i).ok_or_else(|| bad("missing field"))?;
        self.i += 1;
        Ok(c)
    }
    fn end(&self) -> Result<()> {
        if self.i == self.v.len() {
            Ok(())
        } else {
            Err(bad("extra fields"))
        }
    }
    fn u(&mut self) -> Result<u64> {
        cu(self.next()?)
    }
    fn usize(&mut self) -> Result<usize> {
        usize::try_from(self.u()?).map_err(|_| bad("size"))
    }
    fn b(&mut self) -> Result<bool> {
        match self.next()? {
            Cbor::Bool(b) => Ok(*b),
            _ => Err(bad("expected a bool")),
        }
    }
    fn t(&mut self) -> Result<String> {
        ct(self.next()?)
    }
    fn opt_t(&mut self) -> Result<Option<String>> {
        match self.next()? {
            Cbor::Null => Ok(None),
            c => ct(c).map(Some),
        }
    }
    fn opt_u(&mut self) -> Result<Option<u64>> {
        match self.next()? {
            Cbor::Null => Ok(None),
            c => cu(c).map(Some),
        }
    }
    fn b32(&mut self) -> Result<B32> {
        cb32(self.next()?)
    }
    fn b16(&mut self) -> Result<B16> {
        match self.next()? {
            Cbor::Bytes(b) if b.len() == 16 => {
                let mut x = [0u8; 16];
                x.copy_from_slice(b);
                Ok(B16(x))
            }
            _ => Err(bad("expected 16 bytes")),
        }
    }
    fn arr(&mut self) -> Result<&'a [Cbor]> {
        match self.next()? {
            Cbor::Array(v) => Ok(v),
            _ => Err(bad("expected an array")),
        }
    }
    fn ids(&mut self) -> Result<Vec<String>> {
        self.arr()?.iter().map(ct).collect()
    }
}

fn cu(c: &Cbor) -> Result<u64> {
    match c {
        Cbor::Uint(v) => Ok(*v),
        _ => Err(bad("expected an unsigned integer")),
    }
}
fn ct(c: &Cbor) -> Result<String> {
    match c {
        Cbor::Text(s) => Ok(s.clone()),
        _ => Err(bad("expected text")),
    }
}
fn cb32(c: &Cbor) -> Result<B32> {
    match c {
        Cbor::Bytes(b) if b.len() == 32 => {
            let mut x = [0u8; 32];
            x.copy_from_slice(b);
            Ok(B32(x))
        }
        _ => Err(bad("expected 32 bytes")),
    }
}
fn dkey(c: &Cbor) -> Result<Key> {
    let Cbor::Array(v) = c else {
        return Err(bad("key"));
    };
    let [k, id] = v.as_slice() else {
        return Err(bad("key shape"));
    };
    Ok(Key {
        kind: match cu(k)? {
            0 => EntityKind::Resource,
            1 => EntityKind::Record,
            2 => EntityKind::File,
            _ => return Err(bad("key kind")),
        },
        id: ct(id)?,
    })
}
fn dmeta(c: &Cbor) -> Result<Meta> {
    let Cbor::Array(v) = c else {
        return Err(bad("meta"));
    };
    let [cl, path, content, size] = v.as_slice() else {
        return Err(bad("meta shape"));
    };
    Ok(Meta {
        class: match cu(cl)? {
            0 => Class::Resource,
            1 => Class::Record,
            2 => Class::Attachment,
            3 => Class::UnindexedMarkdown,
            _ => return Err(bad("class")),
        },
        path: ct(path)?,
        content: cb32(content)?,
        size: cu(size)?,
    })
}
fn dopt<T>(c: &Cbor, f: impl FnOnce(&Cbor) -> Result<T>) -> Result<Option<T>> {
    match c {
        Cbor::Null => Ok(None),
        c => f(c).map(Some),
    }
}
fn deffect(c: &Cbor) -> Result<Effect> {
    let (tag, mut f) = Fields::of(c)?;
    let e = match tag {
        0 => Effect::Delete {
            key: dkey(f.next()?)?,
            from: dmeta(f.next()?)?,
        },
        1 => Effect::Park {
            key: dkey(f.next()?)?,
            from: dmeta(f.next()?)?,
            to: f.t()?,
        },
        2 => Effect::Put {
            key: dkey(f.next()?)?,
            from: dopt(f.next()?, dmeta)?,
            to: dmeta(f.next()?)?,
        },
        _ => return Err(bad("effect tag")),
    };
    f.end()?;
    Ok(e)
}
fn dbatch(c: &Cbor) -> Result<Batch> {
    let Cbor::Array(v) = c else {
        return Err(bad("batch"));
    };
    let mut f = Fields { v, i: 0 };
    let b = Batch {
        mutation: f.b16()?,
        pass: f.u()?,
        s_final: f.u()?,
        effects: f.arr()?.iter().map(deffect).collect::<Result<_>>()?,
        last: dkey(f.next()?)?,
    };
    f.end()?;
    Ok(b)
}
fn dgen(v: u64) -> Result<Generation> {
    match v {
        0 => Ok(Generation::S0),
        1 => Ok(Generation::Final),
        _ => Err(bad("generation")),
    }
}

/// Decode [`encode_action`].
pub fn decode_action(bytes: &[u8]) -> Result<Action> {
    use Action::*;
    let c = cbor::decode(bytes).map_err(|e| bad(&format!("{e:?}")))?;
    let (tag, mut f) = Fields::of(&c)?;
    let a = match tag {
        0 => EnsureBackup,
        1 => CreateCollection,
        2 => OpenSource {
            generation: dgen(f.u()?)?,
            expect_head: f.opt_u()?,
        },
        3 => ReadPage {
            generation: dgen(f.u()?)?,
            table: match f.u()? {
                0 => Table::Resources,
                1 => Table::Records,
                2 => Table::Files,
                _ => return Err(bad("table")),
            },
            cursor: f.opt_t()?,
            max_rows: f.usize()?,
            max_bytes: f.usize()?,
        },
        4 => {
            let bits = f.u()?;
            let bucket = f.opt_u()?;
            super::bucket_range(bits, bucket.unwrap_or(0))?;
            ImportGen0 {
                bits,
                bucket,
                after: dopt(f.next()?, dkey)?,
            }
        }
        5 => FinishGen0,
        6 => AppendBase {
            manifest: f.b32()?,
            state_digest: f.b32()?,
        },
        7 => FindBase,
        8 => Rebuild { at_least: f.u()? },
        9 => ReadNew { cursor: f.opt_t()? },
        10 => MayFence,
        11 => Fence,
        12 => DrainStatus,
        13 => ListReplicas,
        14 => RevokeReplicas { ids: f.ids()? },
        15 => AppendCutover { s_final: f.u()? },
        16 => FindCutover,
        17 => Replay(dbatch(f.next()?)?),
        18 => FindMutation { mutation: f.b16()? },
        19 => LogHead,
        20 => Route {
            s_final: f.u()?,
            cutover_seq: f.u()?,
            barrier_f: f.u()?,
            final_digest: f.b32()?,
        },
        21 => Unrevoke { ids: f.ids()? },
        22 => Unfence,
        23 => Wait(match f.u()? {
            0 => super::Wait::Paused,
            1 => super::Wait::Draining,
            2 => super::Wait::Keying,
            _ => return Err(bad("wait")),
        }),
        24 => Continue,
        25 => Done(Step::from_u64(f.u()?).ok_or_else(|| bad("step"))?),
        _ => return Err(bad("action tag")),
    };
    f.end()?;
    Ok(a)
}

/// Decode [`encode_outcome`]. The host's answer: anything malformed is refused.
pub fn decode_outcome(bytes: &[u8]) -> Result<Outcome> {
    use Outcome::*;
    let c = cbor::decode(bytes).map_err(|e| bad(&format!("{e:?}")))?;
    let (tag, mut f) = Fields::of(&c)?;
    let o = match tag {
        0 => Ok,
        1 => Backup { hold: f.t()? },
        2 => Created { verified: f.b()? },
        3 => Opened { head: f.u()? },
        4 => Page {
            rows: f
                .arr()?
                .iter()
                .map(|r| {
                    let Cbor::Array(v) = r else {
                        return Err(bad("row"));
                    };
                    let mut g = Fields { v, i: 0 };
                    let row = SourceRow {
                        id: g.opt_t()?,
                        path: g.t()?,
                        content: g.b32()?,
                        size: g.u()?,
                    };
                    g.end()?;
                    Result::Ok(row)
                })
                .collect::<Result<_>>()?,
            next: f.opt_t()?,
        },
        5 => Gen0Progress {
            last: dopt(f.next()?, dkey)?,
            done: f.b()?,
        },
        6 => Gen0Built {
            manifest: f.b32()?,
            state_digest: f.b32()?,
        },
        7 => Appended { seq: f.u()? },
        8 => Unknown,
        9 => Conflict,
        10 => Stale,
        11 => Found { seq: f.opt_u()? },
        12 => Rebuilt { head: f.u()? },
        13 => NewPage {
            rows: f
                .arr()?
                .iter()
                .map(|r| {
                    let Cbor::Array(v) = r else {
                        return Err(bad("entity"));
                    };
                    let [k, m] = v.as_slice() else {
                        return Err(bad("entity shape"));
                    };
                    Result::Ok((dkey(k)?, dmeta(m)?))
                })
                .collect::<Result<_>>()?,
            next: f.opt_t()?,
        },
        14 => MayFence(f.b()?),
        15 => Drain {
            pending: f.u()?,
            head: f.u()?,
        },
        16 => Replicas { ids: f.ids()? },
        17 => Head { seq: f.u()? },
        18 => Gone,
        19 => Failed {
            transient: f.b()?,
            reason: f.t()?,
        },
        _ => return Err(bad("outcome tag")),
    };
    f.end()?;
    Result::Ok(o)
}

#[cfg(test)]
mod tests {
    use super::super::Wait;
    use super::*;

    fn m(c: Class, p: &str) -> Meta {
        Meta {
            class: c,
            path: p.into(),
            content: B32([3; 32]),
            size: 9,
        }
    }
    fn k(i: &str) -> Key {
        Key {
            kind: EntityKind::Record,
            id: i.into(),
        }
    }

    #[test]
    fn every_action_and_outcome_round_trips() {
        let batch = Batch {
            mutation: B16([1; 16]),
            pass: 2,
            s_final: 5,
            effects: vec![
                Effect::Delete {
                    key: k("a"),
                    from: m(Class::Record, "a.md"),
                },
                Effect::Park {
                    key: k("b"),
                    from: m(Class::Attachment, "b.png"),
                    to: "mdbase-migration/x.png".into(),
                },
                Effect::Put {
                    key: k("c"),
                    from: None,
                    to: m(Class::UnindexedMarkdown, "c.md"),
                },
            ],
            last: k("c"),
        };
        let actions = vec![
            Action::EnsureBackup,
            Action::CreateCollection,
            Action::OpenSource {
                generation: Generation::Final,
                expect_head: Some(4),
            },
            Action::OpenSource {
                generation: Generation::S0,
                expect_head: None,
            },
            Action::ReadPage {
                generation: Generation::S0,
                table: Table::Files,
                cursor: Some("c".into()),
                max_rows: 1000,
                max_bytes: 1 << 20,
            },
            Action::ImportGen0 {
                bits: 4,
                bucket: Some(15),
                after: Some(k("z")),
            },
            Action::ImportGen0 {
                bits: 0,
                bucket: None,
                after: None,
            },
            Action::FinishGen0,
            Action::AppendBase {
                manifest: B32([1; 32]),
                state_digest: B32([2; 32]),
            },
            Action::FindBase,
            Action::Rebuild { at_least: 3 },
            Action::ReadNew { cursor: None },
            Action::MayFence,
            Action::Fence,
            Action::DrainStatus,
            Action::ListReplicas,
            Action::RevokeReplicas {
                ids: vec!["r1".into()],
            },
            Action::AppendCutover { s_final: 9 },
            Action::FindCutover,
            Action::Replay(batch),
            Action::FindMutation {
                mutation: B16([9; 16]),
            },
            Action::LogHead,
            Action::Route {
                s_final: 1,
                cutover_seq: 2,
                barrier_f: 3,
                final_digest: B32([4; 32]),
            },
            Action::Unrevoke { ids: vec![] },
            Action::Unfence,
            Action::Wait(Wait::Draining),
            Action::Continue,
            Action::Done(Step::Gone),
        ];
        for a in actions {
            assert_eq!(decode_action(&encode_action(&a).unwrap()).unwrap(), a);
        }
        let outcomes = vec![
            Outcome::Ok,
            Outcome::Backup { hold: "h".into() },
            Outcome::Created { verified: true },
            Outcome::Opened { head: 7 },
            Outcome::Page {
                rows: vec![SourceRow {
                    id: None,
                    path: "mdbase.yaml".into(),
                    content: B32([5; 32]),
                    size: 3,
                }],
                next: Some("n".into()),
            },
            Outcome::Gen0Progress {
                last: Some(k("q")),
                done: false,
            },
            Outcome::Gen0Built {
                manifest: B32([6; 32]),
                state_digest: B32([7; 32]),
            },
            Outcome::Appended { seq: 2 },
            Outcome::Unknown,
            Outcome::Conflict,
            Outcome::Stale,
            Outcome::Found { seq: None },
            Outcome::Found { seq: Some(3) },
            Outcome::Rebuilt { head: 4 },
            Outcome::NewPage {
                rows: vec![(k("x"), m(Class::Record, "x.md"))],
                next: None,
            },
            Outcome::MayFence(false),
            Outcome::Drain {
                pending: 1,
                head: 2,
            },
            Outcome::Replicas {
                ids: vec!["a".into(), "b".into()],
            },
            Outcome::Head { seq: 8 },
            Outcome::Gone,
            Outcome::Failed {
                transient: true,
                reason: "r".into(),
            },
        ];
        for o in outcomes {
            assert_eq!(decode_outcome(&encode_outcome(&o).unwrap()).unwrap(), o);
        }
    }

    #[test]
    fn malformed_host_answers_are_refused() {
        let enc = |c: Cbor| cbor::encode(&c).unwrap();
        assert!(decode_outcome(b"").is_err());
        assert!(decode_outcome(&enc(Cbor::Array(vec![]))).is_err());
        assert!(
            decode_outcome(&enc(Cbor::Array(vec![u(99)]))).is_err(),
            "unknown tag"
        );
        assert!(
            decode_outcome(&enc(Cbor::Array(vec![u(7)]))).is_err(),
            "missing field"
        );
        assert!(
            decode_outcome(&enc(Cbor::Array(vec![u(7), u(1), u(2)]))).is_err(),
            "extra field"
        );
        assert!(
            decode_outcome(&enc(Cbor::Array(vec![
                u(6),
                Cbor::Bytes(vec![1; 31]),
                Cbor::Bytes(vec![1; 32])
            ])))
            .is_err(),
            "short hash"
        );
        assert!(
            decode_outcome(&enc(Cbor::Array(vec![u(2), u(1)]))).is_err(),
            "not a bool"
        );
    }
}
