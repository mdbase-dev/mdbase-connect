//! Log backend measurements, over the wire against any target.

use std::sync::Arc;
use std::time::{Duration, Instant};

use mdbn_log_service::Code;
use mdbn_log_service::testkit::{filler, object};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::B32;
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{
    AppendResult, CommitObjectParams, GetObjectParams, GetObjectResult, ItemsPush, PutObjectParams,
    PutObjectResult, ReadParams, ReadResult, SubscribeParams,
};
use mdbn_wire::schema::Wire;

use crate::client::field;
use crate::fixture::{Fx, Target, e2s};

/// Percentiles of a sample, in ms.
pub fn pct(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let i = ((v.len() as f64 - 1.0) * p).round() as usize;
    v[i]
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// N writers contending on one collection for `secs`.
pub async fn contention(t: &Target, writers: usize, secs: u64) -> Result<String, String> {
    let fx = Arc::new(Fx::new(t).await?);
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut tasks = Vec::new();
    for w in 0..writers {
        let fx = fx.clone();
        tasks.push(tokio::spawn(async move {
            let dev = if w % 2 == 0 { &fx.a } else { &fx.b };
            let c = fx.connect(dev).await?;
            let (mut h, mut chain) = fx.head(&c).await?;
            let (mut rtt, mut e2e, mut moved) = (Vec::new(), Vec::new(), 0u64);
            let mut i = 0u64;
            while Instant::now() < deadline {
                let start = Instant::now();
                loop {
                    let e = fx.entry(dev, h + 1, chain, 1, &format!("c/{w}/{i}"));
                    let s = Instant::now();
                    let r = fx.append(&c, h + 1, chain, vec![e]).await.map_err(e2s)?;
                    rtt.push(ms(s.elapsed()));
                    match r {
                        AppendResult::Appended(a) => {
                            h = a.last;
                            chain = a.head_chain;
                            break;
                        }
                        AppendResult::HeadMoved(m) => {
                            moved += 1;
                            h = m.head;
                            chain = m.head_chain;
                        }
                        AppendResult::Duplicate(_) => return Err("duplicate".to_string()),
                    }
                }
                e2e.push(ms(start.elapsed()));
                i += 1;
            }
            Ok::<_, String>((rtt, e2e, moved))
        }));
    }
    let (mut rtt, mut e2e, mut moved) = (Vec::new(), Vec::new(), 0);
    for t in tasks {
        let (a, b, m) = t.await.map_err(|e| e.to_string())??;
        rtt.extend(a);
        e2e.extend(b);
        moved += m;
    }
    let n = e2e.len();
    Ok(format!(
        "{{\"scenario\":\"contention\",\"writers\":{writers},\"secs\":{secs},\"appends\":{n},\"items_per_s\":{:.1},\"attempts\":{},\"head_moved\":{moved},\"rtt_p50\":{:.2},\"rtt_p99\":{:.2},\"commit_p50\":{:.2},\"commit_p99\":{:.2}}}",
        n as f64 / secs as f64,
        rtt.len(),
        pct(&mut rtt, 0.5),
        pct(&mut rtt, 0.99),
        pct(&mut e2e, 0.5),
        pct(&mut e2e, 0.99),
    ))
}

/// One uncontended writer on each of `n` collections, concurrently.
pub async fn scale(t: &Target, n: usize, secs: u64) -> Result<String, String> {
    let mut fxs = Vec::new();
    let setup = Instant::now();
    let mut pending = Vec::new();
    for _ in 0..n {
        let t = t.clone();
        pending.push(tokio::spawn(async move { Fx::new(&t).await }));
        if pending.len() >= 32 {
            for p in pending.drain(..) {
                fxs.push(Arc::new(p.await.map_err(|e| e.to_string())??));
            }
        }
    }
    for p in pending {
        fxs.push(Arc::new(p.await.map_err(|e| e.to_string())??));
    }
    let setup_s = setup.elapsed().as_secs_f64();
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut tasks = Vec::new();
    for fx in fxs {
        tasks.push(tokio::spawn(async move {
            let c = fx.connect(&fx.a).await?;
            let (mut h, mut chain) = fx.head(&c).await?;
            let mut lat = Vec::new();
            let mut i = 0;
            while Instant::now() < deadline {
                let e = fx.entry(&fx.a, h + 1, chain, 1, &format!("s/{i}"));
                let s = Instant::now();
                match fx.append(&c, h + 1, chain, vec![e]).await.map_err(e2s)? {
                    AppendResult::Appended(a) => {
                        h = a.last;
                        chain = a.head_chain;
                    }
                    o => return Err(format!("{o:?}")),
                }
                lat.push(ms(s.elapsed()));
                i += 1;
            }
            Ok::<_, String>(lat)
        }));
    }
    let mut lat = Vec::new();
    let mut errors = 0;
    for t in tasks {
        match t.await.map_err(|e| e.to_string())? {
            Ok(l) => lat.extend(l),
            Err(_) => errors += 1,
        }
    }
    let total = lat.len();
    Ok(format!(
        "{{\"scenario\":\"scale\",\"collections\":{n},\"secs\":{secs},\"setup_s\":{setup_s:.1},\"appends\":{total},\"items_per_s\":{:.1},\"errors\":{errors},\"p50\":{:.2},\"p99\":{:.2}}}",
        total as f64 / secs as f64,
        pct(&mut lat, 0.5),
        pct(&mut lat, 0.99)
    ))
}

/// `k` subscribers; a writer appends `m` items one by one; time from the append's
/// send to each subscriber's `items` push.
pub async fn fanout(t: &Target, k: usize, m: usize) -> Result<String, String> {
    let fx = Arc::new(Fx::new(t).await?);
    let mut subs = Vec::new();
    for _ in 0..k {
        let c = fx.connect(&fx.b).await?;
        c.call(
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
        subs.push(Arc::new(c));
    }
    let start = Instant::now();
    let mut listeners = Vec::new();
    for s in &subs {
        let s = s.clone();
        listeners.push(tokio::spawn(async move {
            let mut seen = Vec::new();
            while seen.len() < m {
                match s.push(Duration::from_secs(20)).await {
                    Some(p) if p.kind == "items" => {
                        let ip = ItemsPush::from_cbor(&p.payload).unwrap();
                        let at = ms(start.elapsed());
                        for it in ip.items {
                            seen.push((it.seq, at));
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            seen
        }));
    }
    let c = fx.connect(&fx.a).await?;
    let (mut h, mut chain) = fx.head(&c).await?;
    let mut sent = std::collections::BTreeMap::new();
    let mut app = Vec::new();
    for i in 0..m {
        let e = fx.entry(&fx.a, h + 1, chain, 1, &format!("f/{i}"));
        let s = Instant::now();
        sent.insert(h + 1, ms(start.elapsed()));
        match fx.append(&c, h + 1, chain, vec![e]).await.map_err(e2s)? {
            AppendResult::Appended(a) => {
                h = a.last;
                chain = a.head_chain;
            }
            o => return Err(format!("{o:?}")),
        }
        app.push(ms(s.elapsed()));
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let mut lat = Vec::new();
    let mut missing = 0;
    for l in listeners {
        let seen = l.await.map_err(|e| e.to_string())?;
        missing += m.saturating_sub(seen.len());
        for (seq, at) in seen {
            if let Some(s) = sent.get(&seq) {
                lat.push(at - s);
            }
        }
    }
    Ok(format!(
        "{{\"scenario\":\"fanout\",\"subscribers\":{k},\"items\":{m},\"append_p50\":{:.2},\"append_p99\":{:.2},\"push_p50\":{:.2},\"push_p99\":{:.2},\"missing\":{missing}}}",
        pct(&mut app, 0.5),
        pct(&mut app, 0.99),
        pct(&mut lat, 0.5),
        pct(&mut lat, 0.99)
    ))
}

/// Upload and download `parts` blob parts of `mib` MiB, `conc` at a time.
pub async fn blob(t: &Target, parts: usize, mib: usize, conc: usize) -> Result<String, String> {
    let fx = Arc::new(Fx::new(t).await?);
    let http = reqwest::Client::new();
    let data: Vec<(B32, Vec<u8>)> = (0..parts)
        .map(|i| {
            (
                B32(sha256(format!("b/{}/{i}", fx.c.to_hex()).as_bytes()).0),
                object(
                    fx.c,
                    ItemKind::BlobPart,
                    1,
                    filler(&format!("{}/{i}", fx.c.to_hex()), mib << 20),
                ),
            )
        })
        .collect();
    let total: usize = data.iter().map(|d| d.1.len()).sum();
    let sem = Arc::new(tokio::sync::Semaphore::new(conc));
    let up = Instant::now();
    let mut tasks = Vec::new();
    for (addr, bytes) in data.clone() {
        let (fx, http, sem) = (fx.clone(), http.clone(), sem.clone());
        tasks.push(tokio::spawn(async move {
            let _p = sem.acquire().await.unwrap();
            let c = fx.connect(&fx.a).await?;
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
            let d = r.direct.ok_or("no direct")?;
            let mut rq = http.put(&d.url).body(bytes);
            for (k, v) in &d.headers.0 {
                rq = rq.header(k, v);
            }
            let st = rq.send().await.map_err(|e| e.to_string())?.status();
            if !st.is_success() {
                return Err(format!("PUT {st}"));
            }
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
            if field(&ok, 0) != Some(&Cbor::Bool(true)) {
                return Err("commit".into());
            }
            Ok::<_, String>(())
        }));
    }
    for t in tasks {
        t.await.map_err(|e| e.to_string())??;
    }
    let up_s = up.elapsed().as_secs_f64();
    let down = Instant::now();
    let mut tasks = Vec::new();
    for (addr, bytes) in data {
        let (fx, http, sem) = (fx.clone(), http.clone(), sem.clone());
        tasks.push(tokio::spawn(async move {
            let _p = sem.acquire().await.unwrap();
            let c = fx.connect(&fx.a).await?;
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
            let d = g.direct.ok_or("no direct")?;
            let b = http
                .get(&d.url)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .bytes()
                .await
                .map_err(|e| e.to_string())?;
            if b.as_ref() != bytes.as_slice() {
                return Err("bytes differ".into());
            }
            Ok::<_, String>(())
        }));
    }
    for t in tasks {
        t.await.map_err(|e| e.to_string())??;
    }
    let down_s = down.elapsed().as_secs_f64();
    let mb = total as f64 / 1e6;
    Ok(format!(
        "{{\"scenario\":\"blob\",\"parts\":{parts},\"mib\":{mib},\"concurrency\":{conc},\"up_mb_s\":{:.1},\"down_mb_s\":{:.1},\"up_s\":{up_s:.2},\"down_s\":{down_s:.2}}}",
        mb / up_s,
        mb / down_s
    ))
}

/// A writer appending for `secs` while the operator restarts the backend; reports
/// the longest gap between acknowledgements and verifies every acknowledged item.
pub async fn recovery(t: &Target, secs: u64) -> Result<String, String> {
    let fx = Fx::new(t).await?;
    let start = Instant::now();
    let deadline = start + Duration::from_secs(secs);
    let mut acked: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut errors = Vec::new();
    let mut last_ack = 0.0f64;
    let mut max_gap = 0.0f64;
    let mut conn = None;
    let mut pending: Option<(u64, B32, Vec<u8>)> = None;
    let mut i = 0;
    while Instant::now() < deadline {
        if conn.is_none() {
            match fx.connect(&fx.a).await {
                Ok(mut c) => {
                    c.timeout = Duration::from_secs(5);
                    conn = Some(c);
                }
                Err(e) => {
                    errors.push((ms(start.elapsed()), e));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            }
        }
        let c = conn.as_ref().unwrap();
        // Retry the same bytes after an unknown outcome (§4.2): `pending` survives
        // a lost connection.
        if pending.is_none() {
            match fx.head(c).await {
                Ok((h, chain)) => {
                    let e = fx.entry(&fx.a, h + 1, chain, 1, &format!("r/{i}"));
                    pending = Some((h + 1, chain, e));
                }
                Err(e) => {
                    errors.push((ms(start.elapsed()), e));
                    conn = None;
                    continue;
                }
            }
        }
        let (seq, chain, e) = pending.clone().unwrap();
        match fx.append(c, seq, chain, vec![e.clone()]).await {
            Ok(AppendResult::Appended(a)) => {
                let now = ms(start.elapsed());
                if last_ack > 0.0 {
                    max_gap = max_gap.max(now - last_ack);
                }
                last_ack = now;
                acked.push((a.first, e));
                pending = None;
            }
            Ok(_) => pending = None,
            Err(err) if err.code == Code::Unavailable => {
                errors.push((ms(start.elapsed()), err.to_string()));
                conn = None;
                continue;
            }
            Err(err) => return Err(err.to_string()),
        }
        i += 1;
    }
    // Verify durability of every acknowledgement.
    let c = loop {
        match fx.connect(&fx.a).await {
            Ok(c) => break c,
            Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    };
    let r: ReadResult = c
        .call_t(
            "read",
            &ReadParams {
                collection: fx.c,
                after: 0,
                limit: 1000,
                kinds: None,
                max_bytes: None,
            },
        )
        .await
        .map_err(e2s)?;
    let mut all = r.items;
    let mut after = all.last().map_or(0, |i| i.seq);
    let mut more = r.more;
    while more {
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
        after = r.items.last().map_or(after, |i| i.seq);
        more = r.more;
        all.extend(r.items);
    }
    let lost = acked
        .iter()
        .filter(|(s, b)| !all.iter().any(|i| i.seq == *s && i.item.0 == *b))
        .count();
    let first_err = errors.first().map_or(-1.0, |e| e.0);
    Ok(format!(
        "{{\"scenario\":\"recovery\",\"secs\":{secs},\"acked\":{},\"lost_acked\":{lost},\"errors\":{},\"first_error_ms\":{first_err:.0},\"max_gap_ms\":{max_gap:.0}}}",
        acked.len(),
        errors.len()
    ))
}
