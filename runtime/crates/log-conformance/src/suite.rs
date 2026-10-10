//! The conformance suite (`log-service-api.md` §13): written once, run over the
//! wire against any backend.
//!
//! Every case builds its own collection, so cases are independent and may run
//! against a shared, long-lived target. Cases that need failure injection
//! (`/debug/*` hooks) are skipped when the target has none.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use mdbn_log_service::testkit::{Device, filler, id16, object};
use mdbn_log_service::{Code, ServiceError};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B16, B32, B64, Bytes};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::hash::{chain_hash, sha256};
use mdbn_wire::log_service::{
    AppendResult, ByteRange, ClosedPush, CommitObjectParams, EndorseSnapshotParams,
    GetObjectParams, GetObjectResult, GetSnapshotResult, HasObjectsParams, HasObjectsResult,
    HeadParams, HeadPush, HeadResult, ItemsPush, PutObjectParams, PutObjectResult,
    PutSnapshotParams, PutStatus, ReadKinds, ReadParams, ReadResult, StreamEvent, StreamEventKind,
    StreamMsg, StreamRef, StreamSendParams, SubscribeParams,
};
use mdbn_wire::policy::{DeviceRevoke, Freeze, PolicyOp};
use mdbn_wire::schema::Wire;

use crate::client::{Client, Cred, cp_http_call, field, http_call, map, random_uuid};
use crate::fixture::{Fx, Target, e2s};

/// One case's outcome.
#[derive(Debug, Clone)]
pub struct CaseResult {
    /// Case name.
    pub name: &'static str,
    /// `Ok`, `Err(reason)`, or skipped.
    pub outcome: Result<(), String>,
    /// Skipped (no hooks on this target).
    pub skipped: bool,
    /// Wall time.
    pub ms: u128,
}

macro_rules! ensure {
    ($c:expr, $($m:tt)+) => {
        if !$c {
            return Err(format!($($m)+));
        }
    };
}

fn expect_code<T: std::fmt::Debug>(
    r: Result<T, ServiceError>,
    code: Code,
    what: &str,
) -> Result<ServiceError, String> {
    match r {
        Err(e) if e.code == code => Ok(e),
        other => Err(format!("{what}: expected {}, got {other:?}", code.as_str())),
    }
}

fn appended(r: AppendResult) -> Result<mdbn_wire::log_service::Appended, String> {
    match r {
        AppendResult::Appended(a) => Ok(a),
        other => Err(format!("expected appended, got {other:?}")),
    }
}

async fn read_all(fx: &Fx, c: &Client) -> Result<Vec<(u64, Vec<u8>)>, String> {
    let mut out = Vec::new();
    let mut after = 0;
    loop {
        let r: ReadResult = c
            .call_t(
                "read",
                &ReadParams {
                    collection: fx.c,
                    after,
                    limit: 1000,
                    kinds: None,
                    max_bytes: None,
                },
            )
            .await
            .map_err(e2s)?;
        ensure!(!r.behind, "unexpectedly behind");
        for i in &r.items {
            out.push((i.seq, i.item.0.clone()));
            after = i.seq;
        }
        if !r.more {
            return Ok(out);
        }
    }
}

fn signer_of(bytes: &[u8]) -> Option<B16> {
    Item::from_bytes(bytes).ok()?.signer
}

fn tamper_sig(bytes: &[u8]) -> Vec<u8> {
    let mut it = Item::from_bytes(bytes).unwrap();
    let mut s = it.sig.unwrap().0;
    s[5] ^= 1;
    it.sig = Some(B64(s));
    it.to_bytes().unwrap()
}

// ------------------------------------------------------------------ cases

/// I1: N writers in a tight loop produce one chain with every acknowledged item
/// exactly once.
async fn race_many_writers(t: &Target) -> Result<(), String> {
    let fx = Arc::new(Fx::new(t).await?);
    let writers = 8usize;
    let per = 20usize;
    let mut tasks = Vec::new();
    for w in 0..writers {
        let fx = fx.clone();
        tasks.push(tokio::spawn(async move {
            let dev = if w % 2 == 0 { &fx.a } else { &fx.b };
            let c = fx.connect(dev).await?;
            let (mut h, mut chain) = fx.head(&c).await?;
            let mut acked = Vec::new();
            let mut moved = 0u64;
            for i in 0..per {
                loop {
                    let e = fx.entry(dev, h + 1, chain, 1, &format!("race/{w}/{i}"));
                    match fx
                        .append(&c, h + 1, chain, vec![e.clone()])
                        .await
                        .map_err(e2s)?
                    {
                        AppendResult::Appended(a) => {
                            acked.push((a.first, e.clone()));
                            h = a.last;
                            chain = a.head_chain;
                            break;
                        }
                        AppendResult::HeadMoved(m) => {
                            moved += 1;
                            h = m.head;
                            chain = m.head_chain;
                        }
                        AppendResult::Duplicate(d) => {
                            return Err(format!("unexpected duplicate {d:?}"));
                        }
                    }
                }
            }
            Ok::<_, String>((acked, moved))
        }));
    }
    let mut acked = BTreeMap::new();
    for t in tasks {
        let (a, _) = t.await.map_err(|e| e.to_string())??;
        for (seq, bytes) in a {
            ensure!(
                acked.insert(seq, bytes).is_none(),
                "two writers acked at seq {seq}"
            );
        }
    }
    let c = fx.connect(&fx.a).await?;
    let log = read_all(&fx, &c).await?;
    let mut prev = mdbn_wire::hash::CHAIN_ZERO;
    for (i, (seq, bytes)) in log.iter().enumerate() {
        ensure!(*seq == i as u64 + 1, "gap at {seq}");
        let it = Item::from_bytes(bytes).map_err(|e| e.to_string())?;
        ensure!(it.prev == Some(prev), "chain broken at {seq}");
        prev = chain_hash(bytes);
    }
    let by_seq: BTreeMap<u64, &Vec<u8>> = log.iter().map(|(s, b)| (*s, b)).collect();
    for (seq, bytes) in &acked {
        ensure!(
            by_seq.get(seq) == Some(&bytes),
            "acked item at {seq} missing or different"
        );
    }
    let entries = log
        .iter()
        .filter(|(_, b)| Item::from_bytes(b).unwrap().kind == ItemKind::Entry)
        .count();
    ensure!(
        entries == writers * per,
        "expected {} entries, found {entries}",
        writers * per
    );
    let (h, hc) = fx.head(&c).await?;
    ensure!(
        h == log.len() as u64 && hc == prev,
        "head does not match the log"
    );
    Ok(())
}

/// I2: stale position or wrong chain → `head_moved` with the true head.
async fn head_moved(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&c).await?;
    let stale = fx.entry(&fx.a, h, chain, 1, "stale");
    match fx.append(&c, h, chain, vec![stale]).await.map_err(e2s)? {
        AppendResult::HeadMoved(m) => ensure!(
            m.head == h && m.head_chain == chain,
            "wrong head in head_moved"
        ),
        o => return Err(format!("stale seq: {o:?}")),
    }
    let wrong = B32([9; 32]);
    let e = fx.entry(&fx.a, h + 1, wrong, 1, "wrong-prev");
    match fx.append(&c, h + 1, wrong, vec![e]).await.map_err(e2s)? {
        AppendResult::HeadMoved(m) => ensure!(m.head == h && m.head_chain == chain, "wrong head"),
        o => return Err(format!("wrong prev: {o:?}")),
    }
    let ahead = fx.entry(&fx.a, h + 2, chain, 1, "ahead");
    match fx
        .append(&c, h + 2, chain, vec![ahead])
        .await
        .map_err(e2s)?
    {
        AppendResult::HeadMoved(_) => {}
        o => return Err(format!("future seq: {o:?}")),
    }
    ensure!(fx.head(&c).await? == (h, chain), "head changed");
    Ok(())
}

/// I3: a batch is appended entirely or not at all.
async fn batch_all_or_nothing(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&c).await?;
    // Signatures are checked after the chain (§4.1 steps 6–7): tamper the last item.
    let (mut items, _) = fx.entries(&fx.a, h + 1, chain, 1, "batch", 3);
    items[2] = tamper_sig(&items[2]);
    let e = expect_code(
        fx.append(&c, h + 1, chain, items).await,
        Code::Invalid,
        "bad signature",
    )?;
    ensure!(
        e.reason.as_deref() == Some("signature"),
        "reason {:?}",
        e.reason
    );
    let (mut items, _) = fx.entries(&fx.a, h + 1, chain, 1, "batch2", 3);
    items[2] = fx.entry(&fx.a, h + 3, B32([1; 32]), 1, "batch2/broken");
    let e = expect_code(
        fx.append(&c, h + 1, chain, items).await,
        Code::Invalid,
        "broken chain",
    )?;
    ensure!(
        e.reason.as_deref() == Some("chain"),
        "reason {:?}",
        e.reason
    );
    let (mut items, _) = fx.entries(&fx.a, h + 1, chain, 1, "batch3", 3);
    items[2] = fx.entry(&fx.a, h + 3, chain_hash(&items[1]), 7, "batch3/epoch");
    let e = expect_code(
        fx.append(&c, h + 1, chain, items).await,
        Code::Invalid,
        "wrong epoch",
    )?;
    ensure!(
        e.reason.as_deref() == Some("epoch"),
        "reason {:?}",
        e.reason
    );
    ensure!(
        fx.head(&c).await? == (h, chain),
        "a failed batch moved the head"
    );
    let (items, last) = fx.entries(&fx.a, h + 1, chain, 1, "batch4", 64);
    let a = appended(fx.append(&c, h + 1, chain, items).await.map_err(e2s)?)?;
    ensure!(
        a.first == h + 1 && a.last == h + 64 && a.head_chain == last,
        "64-item batch result"
    );
    Ok(())
}

/// I4: retrying the same bytes after a lost response returns the original success,
/// even after others appended on top; different bytes at those positions do not.
async fn retry_after_lost_response(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&c).await?;
    let (items, _) = fx.entries(&fx.a, h + 1, chain, 1, "retry", 2);
    let first = appended(
        fx.append(&c, h + 1, chain, items.clone())
            .await
            .map_err(e2s)?,
    )?;
    let again = appended(
        fx.append(&c, h + 1, chain, items.clone())
            .await
            .map_err(e2s)?,
    )?;
    ensure!(
        first == again,
        "retry result differs: {first:?} vs {again:?}"
    );
    let cb = fx.connect(&fx.b).await?;
    fx.append_at_head(&cb, &fx.b, 1, "on-top", 3)
        .await
        .map_err(e2s)?;
    let late = appended(fx.append(&c, h + 1, chain, items).await.map_err(e2s)?)?;
    ensure!(first == late, "late retry result differs");
    let (other, _) = fx.entries(&fx.a, h + 1, chain, 1, "retry-other", 2);
    match fx.append(&c, h + 1, chain, other).await.map_err(e2s)? {
        AppendResult::HeadMoved(_) => {}
        o => return Err(format!("different bytes at an old position: {o:?}")),
    }
    // A retry of a different-length batch over the same prefix is not a replay.
    let (items3, _) = fx.entries(&fx.a, h + 1, chain, 1, "retry", 3);
    match fx.append(&c, h + 1, chain, items3).await.map_err(e2s)? {
        AppendResult::HeadMoved(_) => Ok(()),
        o => Err(format!("partial overlap: {o:?}")),
    }
}

/// I5: an idempotency token already in the log → `duplicate {index, seq}`.
async fn duplicate_tokens(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&c).await?;
    let token = id16("dup-token");
    let x =
        fx.a.entry(fx.c, h + 1, chain, 1, token, None, filler("x", 100));
    let ax = appended(fx.append(&c, h + 1, chain, vec![x]).await.map_err(e2s)?)?;
    let y =
        fx.a.entry(fx.c, h + 2, ax.head_chain, 1, token, None, filler("y", 100));
    match fx
        .append(&c, h + 2, ax.head_chain, vec![y])
        .await
        .map_err(e2s)?
    {
        AppendResult::Duplicate(d) => ensure!(d.index == 0 && d.seq == ax.first, "duplicate {d:?}"),
        o => return Err(format!("expected duplicate, got {o:?}")),
    }
    let z = fx.a.entry(
        fx.c,
        h + 2,
        ax.head_chain,
        1,
        id16("fresh"),
        None,
        filler("z", 100),
    );
    let y2 = fx.a.entry(
        fx.c,
        h + 3,
        chain_hash(&z),
        1,
        token,
        None,
        filler("y2", 100),
    );
    match fx
        .append(&c, h + 2, ax.head_chain, vec![z, y2])
        .await
        .map_err(e2s)?
    {
        AppendResult::Duplicate(d) => ensure!(d.index == 1 && d.seq == ax.first, "duplicate {d:?}"),
        o => return Err(format!("expected duplicate at index 1, got {o:?}")),
    }
    // The same token twice in one batch is malformed.
    let p = fx.a.entry(
        fx.c,
        h + 2,
        ax.head_chain,
        1,
        id16("twice"),
        None,
        filler("p", 100),
    );
    let q = fx.a.entry(
        fx.c,
        h + 3,
        chain_hash(&p),
        1,
        id16("twice"),
        None,
        filler("q", 100),
    );
    expect_code(
        fx.append(&c, h + 2, ax.head_chain, vec![p, q]).await,
        Code::Invalid,
        "token twice",
    )?;
    ensure!(fx.head(&c).await?.0 == h + 1, "duplicates moved the head");
    Ok(())
}

/// Failover with a lost tail: `expect_prev` catches it, and a replica that applied
/// the lost item detects the fork when it reads.
async fn lost_tail_detected(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let ca = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&ca).await?;
    let mine = fx.entry(&fx.a, h + 1, chain, 1, "lost");
    let a = appended(
        fx.append(&ca, h + 1, chain, vec![mine.clone()])
            .await
            .map_err(e2s)?,
    )?;
    let http = reqwest::Client::new();
    let r = http
        .post(format!(
            "{}/debug/lose_tail/{}/1",
            t.http,
            fx.c.to_uuid_string()
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    ensure!(r.status().is_success(), "lose_tail hook: {}", r.status());
    // B never saw A's item; it appends its own at the same position.
    let cb = fx.connect(&fx.b).await?;
    let (hb, cbh) = fx.head(&cb).await?;
    ensure!(hb == h && cbh == chain, "the tail was not lost");
    let theirs = fx.entry(&fx.b, h + 1, chain, 1, "replacement");
    appended(
        fx.append(&cb, h + 1, chain, vec![theirs])
            .await
            .map_err(e2s)?,
    )?;
    // A continues from its applied head: refused, because chain(h+1) differs.
    let next = fx.entry(&fx.a, h + 2, a.head_chain, 1, "after-lost");
    match fx
        .append(&ca, h + 2, a.head_chain, vec![next])
        .await
        .map_err(e2s)?
    {
        AppendResult::HeadMoved(m) => {
            ensure!(
                m.head == h + 1 && m.head_chain != a.head_chain,
                "fork not visible in head_moved"
            )
        }
        o => return Err(format!("A's append over a lost tail was accepted: {o:?}")),
    }
    let r: ReadResult = ca
        .call_t(
            "read",
            &ReadParams {
                collection: fx.c,
                after: h,
                limit: 1,
                kinds: None,
                max_bytes: None,
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        r.items[0].item.0 != mine,
        "the replica cannot detect the fork"
    );
    Ok(())
}

/// I6 + policy: a revocation racing a device's appends. After the revocation at p,
/// no item by the revoked device exists above p; its subscription is closed; content
/// is refused until a rekey.
async fn revocation_races_append(t: &Target) -> Result<(), String> {
    let fx = Arc::new(Fx::new(t).await?);
    let cb = Arc::new(fx.connect(&fx.b).await?);
    let sub = fx.connect(&fx.b).await?;
    sub.call_t::<_, Cbor>(
        "subscribe",
        &SubscribeParams {
            collection: fx.c,
            after: 0,
            inline_bytes: Some(0),
        },
    )
    .await
    .map_err(e2s)?;
    let fx2 = fx.clone();
    let cb2 = cb.clone();
    let writer = tokio::spawn(async move {
        let mut i = 0;
        loop {
            match fx2
                .append_at_head(&cb2, &fx2.b, 1, &format!("racer/{i}"), 1)
                .await
            {
                Ok(_) => i += 1,
                Err(e) => return (i, e),
            }
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let p = fx
        .policy(vec![PolicyOp::DeviceRevoke(DeviceRevoke {
            device: fx.b.id,
        })])
        .await
        .map_err(e2s)?;
    let (n, err) = tokio::time::timeout(Duration::from_secs(20), writer)
        .await
        .map_err(|_| "revoked writer kept appending".to_string())?
        .map_err(|e| e.to_string())?;
    ensure!(err.code == Code::Forbidden, "revoked writer got {err:?}");
    let ca = fx.connect(&fx.a).await?;
    let log = read_all(&fx, &ca).await?;
    for (seq, bytes) in &log {
        if *seq > p {
            ensure!(
                signer_of(bytes) != Some(fx.b.id),
                "item by revoked device at {seq} > {p}"
            );
        }
    }
    ensure!(n > 0, "racer never appended before the revocation");
    // The revoked device's subscription is closed.
    let mut closed = false;
    loop {
        match sub.push(Duration::from_secs(3)).await {
            Some(p) if p.kind == "closed" => {
                let c = ClosedPush::from_cbor(&p.payload).map_err(|e| e.to_string())?;
                ensure!(c.reason == "forbidden", "closed reason {}", c.reason);
                closed = true;
                break;
            }
            Some(_) => continue,
            None => break,
        }
    }
    ensure!(closed, "no closed push for the revoked device");
    // Revoked: reads and stream joins refused.
    expect_code(
        cb.call_t::<_, HeadResult>("head", &HeadParams { collection: fx.c })
            .await,
        Code::Forbidden,
        "revoked read",
    )?;
    // Rekey required: content refused, then accepted after the rekey.
    let e = expect_code(
        fx.append_at_head(&ca, &fx.a, 1, "before-rekey", 1).await,
        Code::Frozen,
        "rekey required",
    )?;
    ensure!(
        e.reason.as_deref() == Some("rekey_required"),
        "reason {:?}",
        e.reason
    );
    // A rekey that wraps for the revoked device is refused.
    let (h, ch) = fx.head(&ca).await?;
    let bad = fx.a.rekey(fx.c, h + 1, ch, 1, &[fx.a.id, fx.b.id]);
    expect_code(
        fx.append(&ca, h + 1, ch, vec![bad]).await,
        Code::Invalid,
        "rekey to revoked",
    )?;
    fx.rekey(&ca, &fx.a, 1, &[fx.a.id, fx.viewer.id]).await?;
    expect_code(
        fx.append_at_head(&ca, &fx.a, 1, "old-epoch", 1).await,
        Code::Invalid,
        "old epoch",
    )?;
    fx.append_at_head(&ca, &fx.a, 2, "after-rekey", 1)
        .await
        .map_err(e2s)?;
    Ok(())
}

/// §9: pushes carry new items inline (exact bytes) or the head.
async fn subscribe_push(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let sub = fx.connect(&fx.b).await?;
    let heads = fx.connect(&fx.viewer).await?;
    let r = sub
        .call(
            "subscribe",
            SubscribeParams {
                collection: fx.c,
                after: 0,
                inline_bytes: None,
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    let (h0, _) = (field(&r, 0).cloned(), ());
    ensure!(h0.is_some(), "subscribe result has no head");
    heads
        .call(
            "subscribe",
            SubscribeParams {
                collection: fx.c,
                after: 0,
                inline_bytes: Some(0),
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    let c = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&c).await?;
    let (items, last) = fx.entries(&fx.a, h + 1, chain, 1, "pushed", 2);
    appended(
        fx.append(&c, h + 1, chain, items.clone())
            .await
            .map_err(e2s)?,
    )?;
    let p = sub.push(Duration::from_secs(5)).await.ok_or("no push")?;
    ensure!(p.kind == "items", "expected items push, got {}", p.kind);
    let ip = ItemsPush::from_cbor(&p.payload).map_err(|e| e.to_string())?;
    ensure!(ip.head == h + 2 && ip.head_chain == last, "items push head");
    ensure!(
        ip.items.len() == 2 && ip.items[0].item.0 == items[0] && ip.items[1].item.0 == items[1],
        "inline bytes differ (I7)"
    );
    let p = heads
        .push(Duration::from_secs(5))
        .await
        .ok_or("no head push")?;
    ensure!(p.kind == "head", "expected head push, got {}", p.kind);
    let hp = HeadPush::from_cbor(&p.payload).map_err(|e| e.to_string())?;
    ensure!(hp.head == h + 2, "head push head");
    Ok(())
}

/// §5: paging, `more`, and control-only reads.
async fn read_paging_and_kinds(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    fx.append_at_head(&c, &fx.a, 1, "page", 10)
        .await
        .map_err(e2s)?;
    let r: ReadResult = c
        .call_t(
            "read",
            &ReadParams {
                collection: fx.c,
                after: 0,
                limit: 4,
                kinds: None,
                max_bytes: None,
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        r.items.len() == 4 && r.more && r.items[0].seq == 1,
        "first page"
    );
    let r: ReadResult = c
        .call_t(
            "read",
            &ReadParams {
                collection: fx.c,
                after: 0,
                limit: 1000,
                kinds: Some(ReadKinds::Control),
                max_bytes: None,
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(r.items.len() == 3, "control items: {}", r.items.len());
    for i in &r.items {
        let k = Item::from_bytes(&i.item.0).unwrap().kind;
        ensure!(k.is_control(), "entry in a control read");
    }
    ensure!(!r.behind && r.retained_from == 1, "retention fields");
    let all = read_all(&fx, &c).await?;
    ensure!(all.len() == 13, "13 items, got {}", all.len());
    Ok(())
}

/// §5: soft canonical-byte budgets through the actual authenticated transport.
async fn read_byte_budget(t: &Target) -> Result<(), String> {
    async fn page(
        fx: &Fx,
        c: &Client,
        after: u64,
        kinds: Option<ReadKinds>,
        max_bytes: Option<u64>,
    ) -> Result<ReadResult, ServiceError> {
        c.call_t(
            "read",
            &ReadParams {
                collection: fx.c,
                after,
                limit: 1000,
                kinds,
                max_bytes,
            },
        )
        .await
    }

    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    fx.append_at_head(&c, &fx.a, 1, "byte-page", 3)
        .await
        .map_err(e2s)?;
    // A control item after intervening ordinary entries, then an ordinary tail.
    fx.policy(vec![PolicyOp::Freeze(Freeze {
        frozen: false,
        reason: None,
    })])
    .await
    .map_err(e2s)?;
    fx.append_at_head(&c, &fx.a, 1, "byte-tail", 1)
        .await
        .map_err(e2s)?;

    for kinds in [None, Some(ReadKinds::Control)] {
        let all = page(&fx, &c, 0, kinds, None).await.map_err(e2s)?;
        for max_bytes in [Some(8 * 1024 * 1024), Some(u64::MAX)] {
            let r = page(&fx, &c, 0, kinds, max_bytes).await.map_err(e2s)?;
            ensure!(r == all, "omission/default/clamp differ for {kinds:?}");
        }
        let boundary = all.items[0].item.0.len() as u64 + all.items[1].item.0.len() as u64;
        for (cap, n) in [(boundary - 1, 1), (boundary, 2), (1, 1)] {
            let r = page(&fx, &c, 0, kinds, Some(cap)).await.map_err(e2s)?;
            ensure!(r.items == all.items[..n], "ordered prefix/boundary {cap}");
            ensure!(r.more, "truncated page must report more");
            let sum: u64 = r.items.iter().map(|i| i.item.0.len() as u64).sum();
            ensure!(
                sum <= cap || r.items.len() == 1,
                "soft cap exceeded after first item"
            );
        }
        // One-item oversize progress, including filtering across non-control gaps.
        let mut seen = Vec::new();
        let mut after = 0;
        for _ in 0..=all.items.len() {
            let r = page(&fx, &c, after, kinds, Some(1)).await.map_err(e2s)?;
            ensure!(r.items.len() <= 1, "oversize first item must be alone");
            if let Some(i) = r.items.first() {
                ensure!(i.seq > after, "pagination did not progress");
                after = i.seq;
            }
            seen.extend(r.items);
            if !r.more {
                break;
            }
        }
        ensure!(seen == all.items, "lost/duplicated filtered byte page");
        let exhausted = page(&fx, &c, u64::MAX, kinds, Some(1)).await.map_err(e2s)?;
        ensure!(
            exhausted.items.is_empty() && !exhausted.more,
            "exhausted range"
        );
        let e = expect_code(
            page(&fx, &c, 0, kinds, Some(0)).await,
            Code::Invalid,
            "zero byte budget",
        )?;
        ensure!(
            e.reason.as_deref() == Some("max_bytes"),
            "zero budget reason"
        );
    }
    Ok(())
}

/// §3: authentication, key binding, kinds per principal, roles.
async fn auth_and_kinds(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let bad = Client::connect(&t.ws, &fx.c, Cred::BadPossession(&fx.a, &fx.b), &fx.cp).await;
    expect_code(bad.map(|_| ()), Code::Unauthenticated, "bad possession")?;
    let exp = Client::connect(&t.ws, &fx.c, Cred::Expired(&fx.a), &fx.cp).await;
    expect_code(exp.map(|_| ()), Code::Unauthenticated, "expired token")?;
    // A token for A's ID bound to another key: authenticated, but not A in the ACL.
    let impostor = Device::with_id("impostor", fx.a.id, fx.a.account);
    let ci = fx.connect(&impostor).await?;
    expect_code(
        ci.call_t::<_, HeadResult>("head", &HeadParams { collection: fx.c })
            .await,
        Code::Forbidden,
        "key binding",
    )?;
    let cs = fx.connect(&fx.stranger).await?;
    expect_code(
        cs.call_t::<_, HeadResult>("head", &HeadParams { collection: fx.c })
            .await,
        Code::Forbidden,
        "stranger",
    )?;
    // Tokens scoped to a collection (claim 5) work there and nowhere else.
    let scoped = Client::connect(&t.ws, &fx.c, Cred::Scoped(&fx.a, fx.c), &fx.cp)
        .await
        .map_err(e2s)?;
    fx.head(&scoped).await?;
    let elsewhere = Client::connect(&t.ws, &fx.c, Cred::Scoped(&fx.a, random_uuid()), &fx.cp)
        .await
        .map_err(e2s)?;
    let e = expect_code(
        elsewhere
            .call_t::<_, HeadResult>("head", &HeadParams { collection: fx.c })
            .await,
        Code::Forbidden,
        "token for another collection",
    )?;
    ensure!(
        e.reason.as_deref() == Some("token_collection"),
        "reason {:?}",
        e.reason
    );
    let cv = fx.connect(&fx.viewer).await?;
    fx.head(&cv).await?;
    let e = expect_code(
        fx.append_at_head(&cv, &fx.viewer, 1, "viewer", 1).await,
        Code::Forbidden,
        "viewer write",
    )?;
    ensure!(
        e.reason.as_deref() == Some("role"),
        "viewer reason {:?}",
        e.reason
    );
    let ca = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&ca).await?;
    let e = fx.entry(&fx.a, h + 1, chain, 1, "by-cp");
    expect_code(
        fx.append(&fx.cpc, h + 1, chain, vec![e]).await,
        Code::Forbidden,
        "control plane appends entry",
    )?;
    // A device may upload another device's item (a repair append), but
    // authorization is the signer's: a viewer's entry is refused even when an
    // editor's device uploads it.
    let by_viewer = fx.entry(&fx.viewer, h + 1, chain, 1, "by-viewer");
    let e = expect_code(
        fx.append(&ca, h + 1, chain, vec![by_viewer]).await,
        Code::Forbidden,
        "viewer's entry uploaded by an editor",
    )?;
    ensure!(e.reason.as_deref() == Some("role"), "reason {:?}", e.reason);
    // A policy item not signed by a certified key is refused.
    let mut forged = Item::from_bytes(&fx.cp.policy_item(
        fx.c,
        h + 1,
        chain,
        vec![PolicyOp::Freeze(Freeze {
            frozen: true,
            reason: None,
        })],
        1_000_000,
    ))
    .unwrap();
    forged.body = Bytes(forged.body.0.clone());
    let mut s = forged.sig.unwrap().0;
    s[0] ^= 0x40;
    forged.sig = Some(B64(s));
    let e = expect_code(
        fx.append(&fx.cpc, h + 1, chain, vec![forged.to_bytes().unwrap()])
            .await,
        Code::Invalid,
        "forged policy",
    )?;
    ensure!(
        e.reason.as_deref() == Some("signature"),
        "reason {:?}",
        e.reason
    );
    ensure!(
        fx.head(&ca).await? == (h, chain),
        "refused items moved the head"
    );
    Ok(())
}

/// §10/§11: limits, freeze, quota, rate limit, unknown and deleted collections.
async fn limits_and_errors(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&c).await?;
    let (items, _) = fx.entries(&fx.a, h + 1, chain, 1, "too-many", 65);
    expect_code(
        fx.append(&c, h + 1, chain, items).await,
        Code::TooLarge,
        "65 items",
    )?;
    let big = fx.a.entry(
        fx.c,
        h + 1,
        chain,
        1,
        id16("big"),
        None,
        filler("big", 1 << 20),
    );
    expect_code(
        fx.append(&c, h + 1, chain, vec![big]).await,
        Code::TooLarge,
        "item over 1 MiB",
    )?;
    // Freeze.
    fx.policy(vec![PolicyOp::Freeze(Freeze {
        frozen: true,
        reason: Some("test".into()),
    })])
    .await
    .map_err(e2s)?;
    let e = expect_code(
        fx.append_at_head(&c, &fx.a, 1, "frozen", 1).await,
        Code::Frozen,
        "frozen",
    )?;
    ensure!(
        e.reason.as_deref() == Some("frozen"),
        "reason {:?}",
        e.reason
    );
    fx.policy(vec![PolicyOp::Freeze(Freeze {
        frozen: false,
        reason: None,
    })])
    .await
    .map_err(e2s)?;
    fx.append_at_head(&c, &fx.a, 1, "thawed", 1)
        .await
        .map_err(e2s)?;
    // Storage quota: content refused, policy still accepted.
    fx.quota(1, 1_000_000, 1 << 34, 1_000_000).await?;
    expect_code(
        fx.append_at_head(&c, &fx.a, 1, "over-quota", 1).await,
        Code::QuotaExceeded,
        "quota",
    )?;
    fx.policy(vec![PolicyOp::Freeze(Freeze {
        frozen: false,
        reason: None,
    })])
    .await
    .map_err(e2s)?;
    // Rate limit: burst 2, then rate_limited with a retry hint.
    fx.quota(1 << 40, 1, 1 << 34, 2).await?;
    fx.append_at_head(&c, &fx.a, 1, "rl/1", 1)
        .await
        .map_err(e2s)?;
    fx.append_at_head(&c, &fx.a, 1, "rl/2", 1)
        .await
        .map_err(e2s)?;
    let e = expect_code(
        fx.append_at_head(&c, &fx.a, 1, "rl/3", 1).await,
        Code::RateLimited,
        "rate",
    )?;
    ensure!(
        e.retry_after_ms.is_some_and(|ms| ms > 0),
        "no retry_after_ms"
    );
    fx.unlimited().await?;
    // Unknown collection.
    let other = random_uuid();
    let co = Client::connect(&t.ws, &other, Cred::Device(&fx.a), &fx.cp)
        .await
        .map_err(e2s)?;
    expect_code(
        co.call_t::<_, HeadResult>("head", &HeadParams { collection: other })
            .await,
        Code::NotFound,
        "unknown collection",
    )?;
    // Deleted collection: closed push, then gone.
    let sub = fx.connect(&fx.b).await?;
    sub.call(
        "subscribe",
        SubscribeParams {
            collection: fx.c,
            after: 0,
            inline_bytes: Some(0),
        }
        .to_cbor(),
    )
    .await
    .map_err(e2s)?;
    let deletion = random_uuid();
    let epoch = u64::MAX;
    let floor = cp_http_call(
        &reqwest::Client::new(),
        &t.http,
        &fx.cp,
        "registry_record_collection_deletion",
        map(vec![
            (0, B16([0; 16]).to_cbor()),
            (1, fx.c.to_cbor()),
            (2, deletion.to_cbor()),
            (3, Cbor::Uint(epoch)),
        ]),
    )
    .await
    .map_err(e2s)?;
    ensure!(
        field(&floor, 0) == Some(&Cbor::Uint(1))
            && field(&floor, 1) == Some(&fx.c.to_cbor())
            && field(&floor, 2) == Some(&deletion.to_cbor())
            && field(&floor, 3) == Some(&Cbor::Uint(epoch)),
        "wrong independent deletion floor"
    );
    let terminal = Cbor::Array(vec![
        Cbor::Uint(1),
        fx.c.to_cbor(),
        deletion.to_cbor(),
        Cbor::Uint(epoch),
    ]);
    let deleted = fx
        .cpc
        .call(
            "delete_log",
            map(vec![
                (0, fx.c.to_cbor()),
                (1, deletion.to_cbor()),
                (2, Cbor::Uint(epoch)),
            ]),
        )
        .await
        .map_err(e2s)?;
    ensure!(
        field(&deleted, 0) == Some(&Cbor::Bool(true)) && field(&deleted, 1) == Some(&terminal),
        "delete success lacks the matching typed receipt"
    );
    let mut closed = false;
    while let Some(p) = sub.push(Duration::from_secs(3)).await {
        if p.kind == "closed" {
            closed = ClosedPush::from_cbor(&p.payload)
                .map(|c| c.reason == "gone")
                .unwrap_or(false);
            break;
        }
    }
    ensure!(closed, "no closed(gone) push");
    expect_code(
        fx.append_at_head(&c, &fx.a, 1, "gone", 1).await,
        Code::Gone,
        "gone",
    )?;
    Ok(())
}

/// I7, I8: inline objects, idempotent puts, validation, `has_objects`, refs.
async fn objects_inline(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let chunk = object(fx.c, ItemKind::Chunk, 1, filler("chunk", 5000));
    let addr = sha256(&chunk);
    let put = |bytes: Vec<u8>, address: B32, kind: ItemKind| PutObjectParams {
        collection: fx.c,
        address,
        kind,
        size: bytes.len() as u64,
        checksum: sha256(&bytes),
        bytes: Some(Bytes(bytes)),
    };
    let r: PutObjectResult = c
        .call_t("put_object", &put(chunk.clone(), addr, ItemKind::Chunk))
        .await
        .map_err(e2s)?;
    ensure!(r.status == PutStatus::Stored, "first put {:?}", r.status);
    let r: PutObjectResult = c
        .call_t("put_object", &put(chunk.clone(), addr, ItemKind::Chunk))
        .await
        .map_err(e2s)?;
    ensure!(r.status == PutStatus::Exists, "second put {:?}", r.status);
    let g: GetObjectResult = c
        .call_t(
            "get_object",
            &GetObjectParams {
                collection: fx.c,
                address: addr,
                range: None,
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        g.bytes.map(|b| b.0) == Some(chunk.clone()) && g.checksum == addr,
        "get returned other bytes (I7)"
    );
    let missing = B32([0xaa; 32]);
    let hs: HasObjectsResult = c
        .call_t(
            "has_objects",
            &HasObjectsParams {
                collection: fx.c,
                addresses: vec![addr, missing],
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        hs.present == vec![true, false],
        "has_objects {:?}",
        hs.present
    );
    // Validation.
    let other = object(fx.c, ItemKind::Chunk, 1, filler("chunk2", 100));
    expect_code(
        c.call_t::<_, PutObjectResult>(
            "put_object",
            &put(other.clone(), B32([1; 32]), ItemKind::Chunk),
        )
        .await,
        Code::Invalid,
        "chunk address != hash",
    )?;
    let mut p = put(other.clone(), sha256(&other), ItemKind::Chunk);
    p.checksum = B32([2; 32]);
    expect_code(
        c.call_t::<_, PutObjectResult>("put_object", &p).await,
        Code::Invalid,
        "bad checksum",
    )?;
    let foreign = object(random_uuid(), ItemKind::Chunk, 1, filler("foreign", 100));
    expect_code(
        c.call_t::<_, PutObjectResult>(
            "put_object",
            &put(foreign.clone(), sha256(&foreign), ItemKind::Chunk),
        )
        .await,
        Code::Invalid,
        "foreign collection",
    )?;
    expect_code(
        c.call_t::<_, PutObjectResult>(
            "put_object",
            &put(other.clone(), sha256(&other), ItemKind::BlobPart),
        )
        .await,
        Code::Invalid,
        "kind mismatch",
    )?;
    let cs = fx.connect(&fx.stranger).await?;
    expect_code(
        cs.call_t::<_, PutObjectResult>(
            "put_object",
            &put(other.clone(), sha256(&other), ItemKind::Chunk),
        )
        .await,
        Code::Forbidden,
        "stranger put",
    )?;
    // Refs: an entry referencing a missing object is refused with the address.
    let (h, chain) = fx.head(&c).await?;
    let e = fx.a.entry(
        fx.c,
        h + 1,
        chain,
        1,
        id16("refs"),
        Some(vec![addr, missing]),
        filler("refs", 64),
    );
    let err = expect_code(
        fx.append(&c, h + 1, chain, vec![e]).await,
        Code::RefsMissing,
        "refs",
    )?;
    ensure!(
        err.details == Some(Cbor::Array(vec![Cbor::Bytes(missing.0.to_vec())])),
        "refs_missing details {:?}",
        err.details
    );
    let e = fx.a.entry(
        fx.c,
        h + 1,
        chain,
        1,
        id16("refs-ok"),
        Some(vec![addr]),
        filler("refs", 64),
    );
    appended(fx.append(&c, h + 1, chain, vec![e]).await.map_err(e2s)?)?;
    Ok(())
}

async fn http_put(
    http: &reqwest::Client,
    d: &mdbn_wire::log_service::DirectTransfer,
    body: Vec<u8>,
) -> Result<u16, String> {
    let mut rq = http.put(&d.url).body(body);
    for (k, v) in &d.headers.0 {
        rq = rq.header(k, v);
    }
    Ok(rq
        .send()
        .await
        .map_err(|e| e.to_string())?
        .status()
        .as_u16())
}

/// I13 + resume: 8 MiB parts by direct transfer; a crashed upload resumes by
/// skipping the parts that exist; ranged downloads.
async fn blob_direct_resume(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    let http = reqwest::Client::new();
    let parts: Vec<(B32, Vec<u8>)> = (0..3)
        .map(|i| {
            let body = filler(&format!("{}/part/{i}", fx.c.to_hex()), 8 << 20);
            (
                B32(sha256(format!("keyed/{}/{i}", fx.c.to_hex()).as_bytes()).0),
                object(fx.c, ItemKind::BlobPart, 1, body),
            )
        })
        .collect();
    let upload = |i: usize| {
        let (addr, bytes) = parts[i].clone();
        let c = &c;
        let http = &http;
        let fx = &fx;
        async move {
            let r: PutObjectResult = c
                .call_t(
                    "put_object",
                    &PutObjectParams {
                        collection: fx.c,
                        address: addr,
                        kind: ItemKind::BlobPart,
                        size: bytes.len() as u64,
                        checksum: sha256(&bytes),
                        bytes: None,
                    },
                )
                .await
                .map_err(e2s)?;
            if r.status == PutStatus::Exists {
                return Ok::<bool, String>(false);
            }
            let d = r.direct.ok_or("no direct transfer")?;
            let st = http_put(http, &d, bytes).await?;
            ensure!(st == 200, "PUT status {st}");
            let ok = c
                .call(
                    "commit_object",
                    CommitObjectParams {
                        collection: fx.c,
                        address: addr,
                    }
                    .to_cbor(),
                )
                .await
                .map_err(e2s)?;
            ensure!(field(&ok, 0) == Some(&Cbor::Bool(true)), "commit failed");
            Ok(true)
        }
    };
    ensure!(upload(0).await?, "part 0 uploaded");
    ensure!(upload(1).await?, "part 1 uploaded");
    // "Crash": resume from has_objects.
    let addrs: Vec<B32> = parts.iter().map(|p| p.0).collect();
    let hs: HasObjectsResult = c
        .call_t(
            "has_objects",
            &HasObjectsParams {
                collection: fx.c,
                addresses: addrs.clone(),
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        hs.present == vec![true, true, false],
        "resume state {:?}",
        hs.present
    );
    // Part 2: commit before upload is false; a wrong checksum header is refused.
    let (a2, b2) = parts[2].clone();
    let r: PutObjectResult = c
        .call_t(
            "put_object",
            &PutObjectParams {
                collection: fx.c,
                address: a2,
                kind: ItemKind::BlobPart,
                size: b2.len() as u64,
                checksum: sha256(&b2),
                bytes: None,
            },
        )
        .await
        .map_err(e2s)?;
    let d = r.direct.ok_or("no direct transfer")?;
    let early = c
        .call(
            "commit_object",
            CommitObjectParams {
                collection: fx.c,
                address: a2,
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    ensure!(
        field(&early, 0) == Some(&Cbor::Bool(false)),
        "commit before upload"
    );
    let mut bad = b2.clone();
    bad[100] ^= 1;
    ensure!(
        http_put(&http, &d, bad).await? >= 400,
        "corrupted upload accepted"
    );
    ensure!(upload(2).await?, "part 2 uploaded");
    ensure!(!upload(0).await?, "re-upload should be exists");
    // Download: direct GET and ranges.
    let g: GetObjectResult = c
        .call_t(
            "get_object",
            &GetObjectParams {
                collection: fx.c,
                address: a2,
                range: None,
            },
        )
        .await
        .map_err(e2s)?;
    let d = g.direct.ok_or("large object should be a direct transfer")?;
    let whole_sha = mdbn_log_service::service::base64(&sha256(&b2).0);
    let total = b2.len();
    for _ in 0..2 {
        let response = http.get(&d.url).send().await.map_err(|e| e.to_string())?;
        ensure!(response.status().as_u16() == 200, "full direct GET status");
        ensure!(
            response
                .headers()
                .get("content-length")
                .and_then(|h| h.to_str().ok())
                == Some(total.to_string().as_str()),
            "full direct GET exact length header"
        );
        ensure!(
            response.headers().get("content-range").is_none(),
            "full direct GET cannot claim a partial span"
        );
        ensure!(
            response
                .headers()
                .get("x-amz-checksum-sha256")
                .and_then(|h| h.to_str().ok())
                == Some(whole_sha.as_str()),
            "full direct GET whole-object SHA header"
        );
        let full = response.bytes().await.map_err(|e| e.to_string())?;
        ensure!(full.as_ref() == b2.as_slice(), "direct GET bytes differ");
        ensure!(
            full.len() == total && sha256(&full) == sha256(&b2),
            "full direct GET complete hash/length"
        );
    }
    for (start, end) in [(100, 199), (0, 0), (total - 1, total - 1), (0, total - 1)] {
        let response = http
            .get(&d.url)
            .header("range", format!("bytes={start}-{end}"))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        ensure!(
            response.status().as_u16() == 206,
            "closed range must be partial, even when it spans the whole object"
        );
        ensure!(
            response
                .headers()
                .get("content-range")
                .and_then(|h| h.to_str().ok())
                == Some(format!("bytes {start}-{end}/{total}").as_str()),
            "exact range endpoints/full total"
        );
        ensure!(
            response
                .headers()
                .get("content-length")
                .and_then(|h| h.to_str().ok())
                == Some((end - start + 1).to_string().as_str()),
            "range exact length header"
        );
        ensure!(
            response
                .headers()
                .get("x-amz-checksum-sha256")
                .and_then(|h| h.to_str().ok())
                == Some(whole_sha.as_str()),
            "range header must name WHOLE object SHA, not slice hash"
        );
        let part = response.bytes().await.map_err(|e| e.to_string())?;
        ensure!(part.as_ref() == &b2[start..=end], "HTTP range differs");
    }
    for range in [
        "bogus".to_string(),
        "bytes=".into(),
        "items=0-1".into(),
        "bytes=-1".into(),
        "bytes=1-".into(),
        "bytes=0-1,2-3".into(),
        "bytes=1-0".into(),
        "bytes=+0-1".into(),
        "bytes=0-+1".into(),
        "bytes=0 -1".into(),
        "bytes=18446744073709551616-18446744073709551616".into(),
        "bytes=0-18446744073709551615".into(),
        format!("bytes={total}-{total}"),
        format!("bytes=0-{total}"),
        format!("bytes={}-{}", total - 1, total + 10),
    ] {
        let response = http
            .get(&d.url)
            .header("range", range)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        ensure!(
            response.status().as_u16() == 416,
            "malformed or either endpoint outside object must be 416, NEVER clamped or silently full"
        );
        ensure!(
            response
                .headers()
                .get("content-range")
                .and_then(|h| h.to_str().ok())
                == Some(format!("bytes */{total}").as_str()),
            "416 full size header"
        );
        ensure!(
            response.headers().get("x-amz-checksum-sha256").is_none(),
            "refusal must not advertise download checksum"
        );
        ensure!(
            response.bytes().await.map_err(|e| e.to_string())?.len() < 128,
            "refusal must not emit object body"
        );
    }
    // Repeated Range fields: a web `Headers.get` combines them into one
    // multi-range value; a native header map must not serve the first field.
    let response = http
        .get(&d.url)
        .header("range", "bytes=0-1")
        .header("range", "bytes=2-3")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    ensure!(
        response.status().as_u16() == 416,
        "repeated Range fields must be 416, never the first field's span"
    );
    ensure!(
        response
            .headers()
            .get("content-range")
            .and_then(|h| h.to_str().ok())
            == Some(format!("bytes */{total}").as_str()),
        "416 full size header on repeated Range fields"
    );
    ensure!(
        response.bytes().await.map_err(|e| e.to_string())?.len() < 128,
        "refusal must not emit object body"
    );
    // Rejections and repeated downloads do not invalidate immutable resume state.
    let hs: HasObjectsResult = c
        .call_t(
            "has_objects",
            &HasObjectsParams {
                collection: fx.c,
                addresses: vec![a2],
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        hs.present == vec![true],
        "range refusal/retry must not lose committed object"
    );
    let g: GetObjectResult = c
        .call_t(
            "get_object",
            &GetObjectParams {
                collection: fx.c,
                address: a2,
                range: Some(ByteRange {
                    offset: 1000,
                    len: 500,
                }),
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        g.bytes.map(|b| b.0) == Some(b2[1000..1500].to_vec()),
        "proxied range differs"
    );
    // An entry referencing all parts is accepted.
    let (h, chain) = fx.head(&c).await?;
    let e = fx.a.entry(
        fx.c,
        h + 1,
        chain,
        1,
        id16("blob-entry"),
        Some(addrs),
        filler("blob", 64),
    );
    appended(fx.append(&c, h + 1, chain, vec![e]).await.map_err(e2s)?)?;
    // Over 9 MiB is refused.
    let r = c
        .call_t::<_, PutObjectResult>(
            "put_object",
            &PutObjectParams {
                collection: fx.c,
                address: B32([5; 32]),
                kind: ItemKind::BlobPart,
                size: (9 << 20) + 1,
                checksum: B32([0; 32]),
                bytes: None,
            },
        )
        .await;
    expect_code(r, Code::TooLarge, "object over 9 MiB")?;
    Ok(())
}

/// §7: snapshot pointers, refs, ordering and endorsement by another device.
async fn snapshots(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let c = fx.connect(&fx.a).await?;
    fx.append_at_head(&c, &fx.a, 1, "snap", 5)
        .await
        .map_err(e2s)?;
    let (h, _) = fx.head(&c).await?;
    let chunk = object(fx.c, ItemKind::Chunk, 1, filler("snapchunk", 300));
    let ca = sha256(&chunk);
    let manifest = fx.a.manifest(fx.c, 1, vec![ca], filler("manifest", 200));
    let ma = sha256(&manifest);
    for (bytes, kind) in [(chunk, ItemKind::Chunk), (manifest, ItemKind::Manifest)] {
        c.call_t::<_, PutObjectResult>(
            "put_object",
            &PutObjectParams {
                collection: fx.c,
                address: sha256(&bytes),
                kind,
                size: bytes.len() as u64,
                checksum: sha256(&bytes),
                bytes: Some(Bytes(bytes)),
            },
        )
        .await
        .map_err(e2s)?;
    }
    let missing = B32([0xbb; 32]);
    let r = c
        .call(
            "put_snapshot",
            PutSnapshotParams {
                collection: fx.c,
                seq: h,
                manifest: ma,
                refs: vec![ca, missing],
            }
            .to_cbor(),
        )
        .await;
    expect_code(r, Code::RefsMissing, "snapshot refs")?;
    let r = c
        .call(
            "put_snapshot",
            PutSnapshotParams {
                collection: fx.c,
                seq: h + 5,
                manifest: ma,
                refs: vec![ca],
            }
            .to_cbor(),
        )
        .await;
    expect_code(r, Code::Invalid, "snapshot above head")?;
    let r = c
        .call(
            "put_snapshot",
            PutSnapshotParams {
                collection: fx.c,
                seq: h,
                manifest: ma,
                refs: vec![ca],
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    ensure!(field(&r, 0) == Some(&Cbor::Bool(true)), "snapshot accepted");
    let r = c
        .call(
            "put_snapshot",
            PutSnapshotParams {
                collection: fx.c,
                seq: h - 1,
                manifest: ma,
                refs: vec![ca],
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    ensure!(
        field(&r, 0) == Some(&Cbor::Bool(false)),
        "older snapshot refused"
    );
    let g: GetSnapshotResult = c
        .call_t("get_snapshot", &HeadParams { collection: fx.c })
        .await
        .map_err(e2s)?;
    ensure!(
        g.snapshots.len() == 1
            && g.snapshots[0].seq == h
            && !g.snapshots[0].endorsed
            && g.snapshots[0].author == fx.a.id,
        "pointer {:?}",
        g.snapshots
    );
    let r = c
        .call(
            "endorse_snapshot",
            EndorseSnapshotParams {
                collection: fx.c,
                seq: h,
                manifest: ma,
            }
            .to_cbor(),
        )
        .await;
    expect_code(r, Code::Forbidden, "author endorses")?;
    let cb = fx.connect(&fx.b).await?;
    let r = cb
        .call(
            "endorse_snapshot",
            EndorseSnapshotParams {
                collection: fx.c,
                seq: h,
                manifest: ma,
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    ensure!(field(&r, 0) == Some(&Cbor::Bool(true)), "endorsement");
    let hr: HeadResult = cb
        .call_t("head", &HeadParams { collection: fx.c })
        .await
        .map_err(e2s)?;
    ensure!(
        hr.snapshot.is_some_and(|s| s.endorsed && s.seq == h),
        "head snapshot pointer"
    );
    // Young entries are never compacted (snapshot.md §5.1: 10,000 grace, 7 days).
    ensure!(
        hr.retained_from == 1,
        "compacted too early: {}",
        hr.retained_from
    );
    Ok(())
}

/// §8, I11: ephemeral streams — fan-out without echo, limits, never in the log.
async fn ephemeral_streams(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let ca = fx.connect(&fx.a).await?;
    let cb = fx.connect(&fx.b).await?;
    let head_before = fx.head(&ca).await?;
    let s = B16(sha256(b"presence/record-1").0[..16].try_into().unwrap());
    let jp = StreamRef {
        collection: fx.c,
        stream: s,
    }
    .to_cbor();
    async fn join(c: &Client, p: &Cbor) -> Result<Cbor, ServiceError> {
        c.call("stream_join", p.clone()).await
    }
    let r = join(&ca, &jp).await.map_err(e2s)?;
    ensure!(
        field(&r, 0) == Some(&Cbor::Array(vec![])),
        "first joiner sees nobody"
    );
    let r = join(&cb, &jp).await.map_err(e2s)?;
    ensure!(
        field(&r, 0) == Some(&Cbor::Array(vec![fx.a.id.to_cbor()])),
        "second joiner sees A"
    );
    let p = ca
        .push(Duration::from_secs(3))
        .await
        .ok_or("no joined event")?;
    let ev = StreamEvent::from_cbor(&p.payload).map_err(|e| e.to_string())?;
    ensure!(
        p.kind == "stream_event" && ev.device == fx.b.id && ev.event == StreamEventKind::Joined,
        "joined event"
    );
    let msg = fx.a.ephemeral(fx.c, s, 1, filler("cursor", 64));
    let r = ca
        .call(
            "stream_send",
            StreamSendParams {
                collection: fx.c,
                stream: s,
                message: Bytes(msg.clone()),
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    ensure!(field(&r, 0) == Some(&Cbor::Uint(1)), "delivered count");
    let p = cb
        .push(Duration::from_secs(3))
        .await
        .ok_or("no stream message")?;
    let m = StreamMsg::from_cbor(&p.payload).map_err(|e| e.to_string())?;
    ensure!(m.from == fx.a.id && m.message.0 == msg, "message differs");
    ensure!(
        ca.push(Duration::from_millis(200)).await.is_none(),
        "message echoed to its sender"
    );
    // Size limit.
    let big = fx.a.ephemeral(fx.c, s, 1, filler("big", 17 * 1024));
    expect_code(
        ca.call(
            "stream_send",
            StreamSendParams {
                collection: fx.c,
                stream: s,
                message: Bytes(big),
            }
            .to_cbor(),
        )
        .await,
        Code::TooLarge,
        "16 KiB",
    )?;
    // Envelope must name this stream and the sender.
    let wrong = fx.a.ephemeral(fx.c, B16([1; 16]), 1, filler("w", 10));
    expect_code(
        ca.call(
            "stream_send",
            StreamSendParams {
                collection: fx.c,
                stream: s,
                message: Bytes(wrong),
            }
            .to_cbor(),
        )
        .await,
        Code::Invalid,
        "wrong stream id",
    )?;
    let forged = fx.b.ephemeral(fx.c, s, 1, filler("w", 10));
    expect_code(
        ca.call(
            "stream_send",
            StreamSendParams {
                collection: fx.c,
                stream: s,
                message: Bytes(forged),
            }
            .to_cbor(),
        )
        .await,
        Code::Invalid,
        "forged sender",
    )?;
    // Rate: 30 msgs/s per session per stream.
    // Pipelined (not one round trip each), so the burst is a burst on any network.
    let sends = (0..45).map(|i| {
        let m = fx.a.ephemeral(fx.c, s, 1, filler(&format!("m{i}"), 32));
        ca.call(
            "stream_send",
            StreamSendParams {
                collection: fx.c,
                stream: s,
                message: Bytes(m),
            }
            .to_cbor(),
        )
    });
    let mut limited = 0;
    for (i, r) in futures_util::future::join_all(sends)
        .await
        .into_iter()
        .enumerate()
    {
        match r {
            Ok(_) => {}
            Err(e) if e.code == Code::RateLimited => limited += 1,
            Err(e) => return Err(format!("send {i}: {e}")),
        }
    }
    ensure!(limited > 0, "45 messages in a burst were not rate limited");
    // Never persisted (I11).
    ensure!(
        fx.head(&ca).await? == head_before,
        "ephemeral traffic moved the head"
    );
    // Not joined / not enrolled.
    let cv = fx.connect(&fx.viewer).await?;
    let m = fx.viewer.ephemeral(fx.c, s, 1, filler("v", 10));
    expect_code(
        cv.call(
            "stream_send",
            StreamSendParams {
                collection: fx.c,
                stream: s,
                message: Bytes(m),
            }
            .to_cbor(),
        )
        .await,
        Code::Forbidden,
        "send without join",
    )?;
    let cs = fx.connect(&fx.stranger).await?;
    expect_code(join(&cs, &jp).await, Code::Forbidden, "stranger joins")?;
    // Leaving pushes `left`.
    cb.drain().await;
    ca.drain().await;
    cb.call(
        "stream_leave",
        StreamRef {
            collection: fx.c,
            stream: s,
        }
        .to_cbor(),
    )
    .await
    .map_err(e2s)?;
    let mut left = false;
    while let Some(p) = ca.push(Duration::from_secs(2)).await {
        if p.kind == "stream_event"
            && StreamEvent::from_cbor(&p.payload)
                .is_ok_and(|e| e.device == fx.b.id && e.event == StreamEventKind::Left)
        {
            left = true;
            break;
        }
    }
    ensure!(left, "no left event");
    // Sessions per stream: 64.
    let s2 = B16([7; 16]);
    let mut conns = Vec::new();
    let mut refused = None;
    for i in 0..65 {
        let c = fx.connect(&fx.a).await?;
        match c
            .call(
                "stream_join",
                StreamRef {
                    collection: fx.c,
                    stream: s2,
                }
                .to_cbor(),
            )
            .await
        {
            Ok(_) => conns.push(c),
            Err(e) => {
                refused = Some((i, e));
                break;
            }
        }
    }
    match refused {
        Some((64, e)) if e.code == Code::RateLimited => {}
        other => return Err(format!("65th session: {other:?}")),
    }
    for c in &conns {
        c.close();
    }
    Ok(())
}

/// §2: plain HTTPS unary requests with proof of possession.
async fn http_unary(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let http = reqwest::Client::new();
    let r = http_call(
        &http,
        &t.http,
        &fx.a,
        &fx.cp,
        "head",
        HeadParams { collection: fx.c }.to_cbor(),
    )
    .await
    .map_err(e2s)?;
    let h = HeadResult::from_cbor(&r).map_err(|e| e.to_string())?;
    ensure!(h.head == 3, "head over HTTP {}", h.head);
    let r = http_call(
        &http,
        &t.http,
        &fx.stranger,
        &fx.cp,
        "head",
        HeadParams { collection: fx.c }.to_cbor(),
    )
    .await;
    expect_code(r, Code::Forbidden, "stranger over HTTP")?;
    Ok(())
}

/// a direct-upload URL can never overwrite a committed object, and a
/// revoked device's upload is never committed.
async fn upload_url_cannot_overwrite(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let ca = fx.connect(&fx.a).await?;
    let cb = fx.connect(&fx.b).await?;
    let http = reqwest::Client::new();
    let part = |label: &str| object(fx.c, ItemKind::BlobPart, 1, filler(label, 2 << 20));
    let addr = B32(sha256(format!("keyed/{}/victim", fx.c.to_hex()).as_bytes()).0);
    let honest = part("honest");
    let evil = part("evil");
    async fn ask(
        c: &Client,
        coll: mdbn_wire::common::Uuid,
        bytes: &[u8],
        address: B32,
    ) -> Result<PutObjectResult, ServiceError> {
        let p = PutObjectParams {
            collection: coll,
            address,
            kind: ItemKind::BlobPart,
            size: bytes.len() as u64,
            checksum: sha256(bytes),
            bytes: None,
        };
        c.call_t::<_, PutObjectResult>("put_object", &p).await
    }
    // B gets a URL first, A uploads and commits the real object.
    let evil_url = ask(&cb, fx.c, &evil, addr)
        .await
        .map_err(e2s)?
        .direct
        .ok_or("no url")?;
    let honest_url = ask(&ca, fx.c, &honest, addr)
        .await
        .map_err(e2s)?
        .direct
        .ok_or("no url")?;
    ensure!(
        http_put(&http, &honest_url, honest.clone()).await? == 200,
        "honest PUT"
    );
    let ok = ca
        .call(
            "commit_object",
            CommitObjectParams {
                collection: fx.c,
                address: addr,
            }
            .to_cbor(),
        )
        .await
        .map_err(e2s)?;
    ensure!(field(&ok, 0) == Some(&Cbor::Bool(true)), "honest commit");
    // B's stale URL still accepts bytes, but only into B's staging key.
    let st = http_put(&http, &evil_url, evil.clone()).await?;
    ensure!(st == 200 || st >= 400, "evil PUT status {st}");
    let _ = cb
        .call(
            "commit_object",
            CommitObjectParams {
                collection: fx.c,
                address: addr,
            }
            .to_cbor(),
        )
        .await;
    let g: GetObjectResult = ca
        .call_t(
            "get_object",
            &GetObjectParams {
                collection: fx.c,
                address: addr,
                range: None,
            },
        )
        .await
        .map_err(e2s)?;
    let d = g.direct.ok_or("no direct get")?;
    let got = http
        .get(&d.url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    ensure!(
        got.as_ref() == honest.as_slice() && g.checksum == sha256(&honest),
        "committed object was overwritten"
    );
    // A device revoked between getting a URL and committing: nothing is committed.
    let addr2 = B32(sha256(format!("keyed/{}/late", fx.c.to_hex()).as_bytes()).0);
    let late = part("late");
    let url2 = ask(&cb, fx.c, &late, addr2)
        .await
        .map_err(e2s)?
        .direct
        .ok_or("no url")?;
    fx.policy(vec![PolicyOp::DeviceRevoke(DeviceRevoke {
        device: fx.b.id,
    })])
    .await
    .map_err(e2s)?;
    let _ = http_put(&http, &url2, late).await?;
    let r = cb
        .call(
            "commit_object",
            CommitObjectParams {
                collection: fx.c,
                address: addr2,
            }
            .to_cbor(),
        )
        .await;
    expect_code(r, Code::Forbidden, "revoked device commits")?;
    let hs: HasObjectsResult = ca
        .call_t(
            "has_objects",
            &HasObjectsParams {
                collection: fx.c,
                addresses: vec![addr2],
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        hs.present == vec![false],
        "revoked device's upload became visible"
    );
    // Snapshot objects: put_object refuses an address that is not the hash.
    let chunk = object(fx.c, ItemKind::Chunk, 1, filler("c", 10));
    let r = ca
        .call_t::<_, PutObjectResult>(
            "put_object",
            &PutObjectParams {
                collection: fx.c,
                address: B32([3; 32]),
                kind: ItemKind::Chunk,
                size: chunk.len() as u64,
                checksum: sha256(&chunk),
                bytes: None,
            },
        )
        .await;
    expect_code(r, Code::Invalid, "chunk address != checksum")?;
    Ok(())
}

/// §12 `revoke_device_credentials`: the device is refused on every collection at
/// the transport (new connections and existing ones), before any policy item.
async fn revoke_device_credentials(t: &Target) -> Result<(), String> {
    let fx1 = Fx::new(t).await?;
    let fx2 = Fx::new(t).await?;
    // B has a live, subscribed connection to collection 1.
    let sub = fx1.connect(&fx1.b).await?;
    sub.call(
        "subscribe",
        SubscribeParams {
            collection: fx1.c,
            after: 0,
            inline_bytes: Some(0),
        }
        .to_cbor(),
    )
    .await
    .map_err(e2s)?;
    // The same device is a member of collection 2 too.
    fx2.policy(vec![
        PolicyOp::MemberSet(mdbn_wire::policy::MemberSet {
            account: fx1.b.account,
            role: mdbn_wire::policy::Role::Editor,
        }),
        fx1.b.enrol(mdbn_wire::policy::DeviceKind::Mobile),
    ])
    .await
    .map_err(e2s)?;
    let other = fx2.connect(&fx1.b).await?;
    fx2.head(&other).await?;
    fx1.cpc
        .call(
            "revoke_device_credentials",
            map(vec![(0, fx1.b.id.to_cbor())]),
        )
        .await
        .map_err(e2s)?;
    // New connections are refused at hello, on any collection.
    for fx in [&fx1, &fx2] {
        let e = expect_code(
            Client::connect(&t.ws, &fx.c, Cred::Device(&fx1.b), &fx.cp)
                .await
                .map(|_| ()),
            Code::Forbidden,
            "hello after revocation",
        )?;
        ensure!(
            e.reason.as_deref() == Some("credentials_revoked"),
            "reason {:?}",
            e.reason
        );
    }
    // The existing connection on the other collection is refused on its next request
    // (within the re-check interval on hosts that cache).
    let mut refused = false;
    for _ in 0..40 {
        match other
            .call_t::<_, HeadResult>("head", &HeadParams { collection: fx2.c })
            .await
        {
            Err(e) if e.code == Code::Forbidden => {
                refused = true;
                break;
            }
            _ => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
    ensure!(refused, "existing connection still served after revocation");
    // Other devices are unaffected.
    let ca = fx1.connect(&fx1.a).await?;
    fx1.append_at_head(&ca, &fx1.a, 1, "after-cred-revoke", 1)
        .await
        .map_err(e2s)?;
    Ok(())
}

/// Lost-tail repair: after a failover loses acknowledged items, another device
/// re-appends their exact bytes at the same positions, policy effects included.
/// The signer's authorization applies; the uploader only needs to be active.
async fn repair_append_restores_lost_tail(t: &Target) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let ca = fx.connect(&fx.a).await?;
    let (h, chain) = fx.head(&ca).await?;
    // A's entry, then a policy item enrolling a new device C, both acknowledged.
    let e1 = fx.entry(&fx.a, h + 1, chain, 1, "lost-1");
    appended(
        fx.append(&ca, h + 1, chain, vec![e1.clone()])
            .await
            .map_err(e2s)?,
    )?;
    let c_dev = Device::new(&format!("{}/c", fx.c.to_hex()), fx.a.account);
    let p_seq = fx
        .policy(vec![c_dev.enrol(mdbn_wire::policy::DeviceKind::Cli)])
        .await
        .map_err(e2s)?;
    ensure!(p_seq == h + 2, "policy at {p_seq}");
    let log = read_all(&fx, &ca).await?;
    let pol = log
        .iter()
        .find(|(s, _)| *s == p_seq)
        .ok_or("policy item")?
        .1
        .clone();
    let (_, top) = fx.head(&ca).await?;
    // The service loses both.
    let http = reqwest::Client::new();
    let r = http
        .post(format!(
            "{}/debug/lose_tail/{}/2",
            t.http,
            fx.c.to_uuid_string()
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    ensure!(r.status().is_success(), "lose_tail hook: {}", r.status());
    ensure!(fx.head(&ca).await? == (h, chain), "tail not lost");
    // C is unknown again.
    let cc = fx.connect(&c_dev).await?;
    expect_code(
        cc.call_t::<_, HeadResult>("head", &HeadParams { collection: fx.c })
            .await,
        Code::Forbidden,
        "C before repair",
    )?;
    // B restores A's entry and the control plane's policy item, exact bytes.
    let cb = fx.connect(&fx.b).await?;
    let a = appended(
        fx.append(&cb, h + 1, chain, vec![e1.clone(), pol.clone()])
            .await
            .map_err(e2s)?,
    )?;
    ensure!(
        a.first == h + 1 && a.last == h + 2 && a.head_chain == top,
        "restored head {a:?}"
    );
    let r: ReadResult = cb
        .call_t(
            "read",
            &ReadParams {
                collection: fx.c,
                after: h,
                limit: 10,
                kinds: None,
                max_bytes: None,
            },
        )
        .await
        .map_err(e2s)?;
    ensure!(
        r.items.len() == 2 && r.items[0].item.0 == e1 && r.items[1].item.0 == pol,
        "restored bytes"
    );
    // The policy item's transport effect was applied again: C may read.
    let cc = fx.connect(&c_dev).await?;
    fx.head(&cc).await?;
    // A second repairer converges through I4.
    appended(
        fx.append(&ca, h + 1, chain, vec![e1, pol])
            .await
            .map_err(e2s)?,
    )?;
    // An item cannot be moved: A's next-position entry re-sent after a different
    // predecessor fails (the head and chain must match).
    let late = fx.entry(&fx.a, h + 3, top, 1, "late");
    let wrong_prev = fx.entry(&fx.a, h + 3, B32([3; 32]), 1, "late");
    match fx
        .append(&cb, h + 3, B32([3; 32]), vec![wrong_prev])
        .await
        .map_err(e2s)?
    {
        AppendResult::HeadMoved(_) => {}
        o => return Err(format!("misplaced item: {o:?}")),
    }
    appended(fx.append(&cb, h + 3, top, vec![late]).await.map_err(e2s)?)?;
    // The uploader must be an active device; the stranger can't upload A's items.
    let cs = fx.connect(&fx.stranger).await?;
    let (h2, c2) = fx.head(&ca).await?;
    let e = fx.entry(&fx.a, h2 + 1, c2, 1, "via-stranger");
    expect_code(
        fx.append(&cs, h2 + 1, c2, vec![e]).await,
        Code::Forbidden,
        "stranger uploads",
    )?;
    Ok(())
}

type CaseFn = for<'a> fn(
    &'a Target,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>,
>;

macro_rules! case {
    ($f:ident, $hooks:expr) => {
        (stringify!($f), $hooks, (|t| Box::pin($f(t))) as CaseFn)
    };
}

/// Every case: `(name, needs debug hooks, fn)`.
pub fn cases() -> Vec<(&'static str, bool, CaseFn)> {
    vec![
        case!(race_many_writers, false),
        case!(head_moved, false),
        case!(batch_all_or_nothing, false),
        case!(retry_after_lost_response, false),
        case!(duplicate_tokens, false),
        case!(lost_tail_detected, true),
        case!(revocation_races_append, false),
        case!(subscribe_push, false),
        case!(read_paging_and_kinds, false),
        case!(read_byte_budget, false),
        case!(auth_and_kinds, false),
        case!(limits_and_errors, false),
        case!(objects_inline, false),
        case!(blob_direct_resume, false),
        case!(upload_url_cannot_overwrite, false),
        case!(snapshots, false),
        case!(ephemeral_streams, false),
        case!(http_unary, false),
        case!(revoke_device_credentials, false),
        case!(repair_append_restores_lost_tail, true),
    ]
}

/// Run every case (optionally only those whose name contains `filter`).
pub async fn run(t: &Target, filter: Option<&str>) -> Vec<CaseResult> {
    let mut out = Vec::new();
    for (name, hooks, f) in cases() {
        if filter.is_some_and(|x| !name.contains(x)) {
            continue;
        }
        let start = std::time::Instant::now();
        if hooks && !t.debug_hooks {
            out.push(CaseResult {
                name,
                outcome: Ok(()),
                skipped: true,
                ms: 0,
            });
            continue;
        }
        let outcome = match tokio::time::timeout(Duration::from_secs(180), f(t)).await {
            Ok(r) => r,
            Err(_) => Err("timed out".into()),
        };
        out.push(CaseResult {
            name,
            outcome,
            skipped: false,
            ms: start.elapsed().as_millis(),
        });
    }
    out
}

/// Print a report; true when every case passed.
pub fn report(t: &Target, results: &[CaseResult]) -> bool {
    let mut ok = true;
    eprintln!("conformance against {}:", t.name);
    for r in results {
        match (&r.outcome, r.skipped) {
            (_, true) => eprintln!("  SKIP {} (needs debug hooks)", r.name),
            (Ok(()), _) => eprintln!("  PASS {} ({} ms)", r.name, r.ms),
            (Err(e), _) => {
                ok = false;
                eprintln!("  FAIL {}: {e}", r.name);
            }
        }
    }
    ok
}
