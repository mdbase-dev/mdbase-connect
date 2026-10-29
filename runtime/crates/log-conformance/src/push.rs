//! Browser push transport (Durable Object host): the single-use `n` nonce, any
//! `Origin` without authority, platform ping/pong, and the server closing a socket whose
//! access ended. Adversarial: revoked sockets are closed by the server, writes
//! from a revoked device are refused, and a stale reconnect fails closed.
//!
//! Run by `logsvc-bench --url … push --origin <browser origin>`; the Postgres
//! gateway keeps the closed-push-only behaviour and is not a target here.

use std::time::Duration;

use mdbn_log_service::Code;
use mdbn_wire::common::Uuid;
use mdbn_wire::log_service::{
    AppendParams, ClosedPush, HeadParams, HeadResult, LsPush, SubscribeParams,
};
use mdbn_wire::policy::{DeviceRevoke, PolicyOp};
use mdbn_wire::schema::Wire;

use crate::client::{Client, ConnectOpts, Cred, http_call, map, now_ms};
use crate::fixture::{Fx, Target, e2s};
use crate::suite::CaseResult;

/// Server close codes (`deploy/cloudflare-do`).
pub const CLOSE_EXPIRED: u16 = 4401;
/// Access ended: never reconnect.
pub const CLOSE_FORBIDDEN: u16 = 4403;

macro_rules! ensure {
    ($c:expr, $($m:tt)+) => {
        if !$c {
            return Err(format!($($m)+));
        }
    };
}

fn browser(t: &Target, origin: &str) -> ConnectOpts {
    ConnectOpts {
        http_nonce: Some(t.http.clone()),
        origin: Some(origin.to_string()),
        ..ConnectOpts::default()
    }
}

async fn subscribe(c: &Client, collection: Uuid) -> Result<(), String> {
    c.call(
        "subscribe",
        SubscribeParams {
            collection,
            after: 0,
            inline_bytes: Some(65536),
        }
        .to_cbor(),
    )
    .await
    .map(|_| ())
    .map_err(e2s)
}

async fn next_kind(c: &Client, kinds: &[&str], wait: Duration) -> Option<LsPush> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match c.push(left).await {
            Some(p) if kinds.contains(&p.kind.as_str()) => return Some(p),
            Some(_) => continue,
            None => return None,
        }
    }
}

/// `n` nonce: hello right after open, live pushes, ping answered, and the same
/// nonce refused a second time; a foreign `Origin` opens but gets nothing pre-hello.
async fn push_browser_session(t: &Target, origin: &str) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let opts = browser(t, origin);
    let b = Client::connect_with(&t.ws, &fx.c, Cred::Device(&fx.b), &fx.cp, &opts)
        .await
        .map_err(e2s)?;
    subscribe(&b, fx.c).await?;
    // A browser session carries push only; requests go over signed HTTPS.
    let r = b
        .call("head", HeadParams { collection: fx.c }.to_cbor())
        .await;
    ensure!(
        matches!(&r, Err(e) if e.code == Code::Forbidden && e.reason.as_deref() == Some("push_only")),
        "request on a browser push socket: {r:?}"
    );
    ensure!(
        b.ping(Duration::from_secs(5)).await,
        "no pong for a text ping"
    );
    let a = fx.connect(&fx.a).await?;
    let started = std::time::Instant::now();
    let first = fx
        .append_at_head(&a, &fx.a, 1, "push/1", 1)
        .await
        .map_err(e2s)?;
    let p = next_kind(&b, &["items", "head"], Duration::from_secs(10))
        .await
        .ok_or("no push for another device's append")?;
    eprintln!(
        "    push latency {} ms ({} at {first})",
        started.elapsed().as_millis(),
        p.kind
    );
    // The nonce was consumed by the first upgrade.
    let replay = ConnectOpts {
        nonce: Some(mdbn_wire::render::hex(&b.hello_nonce)),
        origin: Some(origin.to_string()),
        ..ConnectOpts::default()
    };
    ensure!(
        Client::open(&t.ws, &fx.c, &replay).await.is_err(),
        "a used nonce opened a second socket"
    );
    let forged = ConnectOpts {
        nonce: Some("11".repeat(32)),
        ..ConnectOpts::default()
    };
    ensure!(
        Client::open(&t.ws, &fx.c, &forged).await.is_err(),
        "a forged nonce opened a socket"
    );
    // `Origin` is not authority: any origin may open a socket with a fresh
    // nonce, and nothing is served before a signed `hello`.
    let evil = browser(t, "https://evil.test");
    let anon = Client::open(&t.ws, &fx.c, &evil)
        .await
        .map_err(|e| format!("a foreign origin could not open a socket: {e:?}"))?;
    let r = anon
        .call(
            "subscribe",
            SubscribeParams {
                collection: fx.c,
                after: 0,
                inline_bytes: None,
            }
            .to_cbor(),
        )
        .await;
    ensure!(
        matches!(&r, Err(e) if e.code == Code::Unauthenticated),
        "subscribe before hello: {r:?}"
    );
    Ok(())
}

/// A device revoked by policy: its subscribed socket gets `closed(forbidden)`
/// and is then closed by the server, its writes are refused, and reconnecting
/// cannot subscribe again.
async fn push_policy_revocation(t: &Target, origin: &str) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let opts = browser(t, origin);
    let b = Client::connect_with(&t.ws, &fx.c, Cred::Device(&fx.b), &fx.cp, &opts)
        .await
        .map_err(e2s)?;
    subscribe(&b, fx.c).await?;
    let started = std::time::Instant::now();
    fx.policy(vec![PolicyOp::DeviceRevoke(DeviceRevoke {
        device: fx.b.id,
    })])
    .await
    .map_err(e2s)?;
    let p = next_kind(&b, &["closed"], Duration::from_secs(10))
        .await
        .ok_or("no closed push for the revoked device")?;
    let c = ClosedPush::from_cbor(&p.payload).map_err(|e| e.to_string())?;
    ensure!(c.reason == "forbidden", "closed reason {}", c.reason);
    let code = b.close_code(Duration::from_secs(10)).await;
    ensure!(
        code == Some(Some(CLOSE_FORBIDDEN)),
        "revoked socket close: {code:?}"
    );
    eprintln!(
        "    policy revocation to server close {} ms",
        started.elapsed().as_millis()
    );
    // A write from the revoked device (the SDK writes over HTTPS) is refused.
    let http = reqwest::Client::new();
    let h: HeadResult = HeadResult::from_cbor(
        &http_call(
            &http,
            &t.http,
            &fx.a,
            &fx.cp,
            "head",
            HeadParams { collection: fx.c }.to_cbor(),
        )
        .await
        .map_err(e2s)?,
    )
    .map_err(|e| e.to_string())?;
    let item = fx.entry(&fx.b, h.head + 1, h.head_chain, 1, "revoked/write");
    let w = http_call(
        &http,
        &t.http,
        &fx.b,
        &fx.cp,
        "append",
        AppendParams {
            collection: fx.c,
            expect_seq: h.head + 1,
            expect_prev: h.head_chain,
            items: vec![mdbn_wire::common::Bytes(item)],
        }
        .to_cbor(),
    )
    .await;
    ensure!(
        matches!(&w, Err(e) if e.code == Code::Forbidden),
        "revoked HTTPS write: {w:?}"
    );
    // A stale tab reconnecting: the socket opens, the subscription is refused.
    let again = Client::connect_with(&t.ws, &fx.c, Cred::Device(&fx.b), &fx.cp, &opts)
        .await
        .map_err(e2s)?;
    let s = subscribe(&again, fx.c).await;
    ensure!(
        s.as_ref().is_err_and(|e| e.contains("forbidden")),
        "revoked device resubscribed: {s:?}"
    );
    Ok(())
}

/// Device credentials revoked (sign-out of a lost device): a stale socket's next
/// request is refused, and a reconnect fails closed at `hello`.
async fn push_credential_revocation(t: &Target, origin: &str) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let opts = browser(t, origin);
    let b = Client::connect_with(&t.ws, &fx.c, Cred::Device(&fx.b), &fx.cp, &opts)
        .await
        .map_err(e2s)?;
    subscribe(&b, fx.c).await?;
    fx.cpc
        .call(
            "revoke_device_credentials",
            map(vec![(0, fx.b.id.to_cbor())]),
        )
        .await
        .map_err(e2s)?;
    let again = Client::connect_with(&t.ws, &fx.c, Cred::Device(&fx.b), &fx.cp, &opts).await;
    ensure!(
        matches!(&again, Err(e) if e.code == Code::Forbidden
            && e.reason.as_deref() == Some("credentials_revoked")),
        "reconnect after credential revocation: {:?}",
        again.err()
    );
    Ok(())
}

/// A session whose token expired gets no more pushes: the server closes it with
/// the expired code on the next push, and the client reconnects with a new token.
async fn push_expired_session(t: &Target, origin: &str) -> Result<(), String> {
    let fx = Fx::new(t).await?;
    let opts = ConnectOpts {
        exp: Some(now_ms() + 3_000),
        ..browser(t, origin)
    };
    let b = Client::connect_with(&t.ws, &fx.c, Cred::Device(&fx.b), &fx.cp, &opts)
        .await
        .map_err(e2s)?;
    subscribe(&b, fx.c).await?;
    tokio::time::sleep(Duration::from_millis(3_500)).await;
    let a = fx.connect(&fx.a).await?;
    fx.append_at_head(&a, &fx.a, 1, "after-expiry", 1)
        .await
        .map_err(e2s)?;
    let code = b.close_code(Duration::from_secs(10)).await;
    ensure!(
        code == Some(Some(CLOSE_EXPIRED)),
        "expired session close: {code:?}"
    );
    ensure!(
        b.drain()
            .await
            .iter()
            .all(|p| p.kind != "items" && p.kind != "head"),
        "an expired session received data"
    );
    Ok(())
}

type PushFn = for<'a> fn(
    &'a Target,
    &'a str,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>,
>;

macro_rules! case {
    ($f:ident) => {
        (stringify!($f), (|t, o| Box::pin($f(t, o))) as PushFn)
    };
}

/// Run the push cases; `origin` is the browser `Origin` sent at the upgrade.
pub async fn run(t: &Target, origin: &str) -> Vec<CaseResult> {
    let cases = [
        case!(push_browser_session),
        case!(push_policy_revocation),
        case!(push_credential_revocation),
        case!(push_expired_session),
    ];
    let mut out = Vec::new();
    for (name, f) in cases {
        let start = std::time::Instant::now();
        let outcome = match tokio::time::timeout(Duration::from_secs(120), f(t, origin)).await {
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
