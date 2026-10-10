//! `logsvc`: run the log service gateway.
//!
//! ```text
//! logsvc --listen 127.0.0.1:7700 --backend pg --pg-url postgres://... \
//!        --objects ./target/logsvc-objects --public-base http://127.0.0.1:7700 \
//!        --testkit-cp conformance [--pool 32] [--debug-hooks] [--notify-in-txn]
//! ```
//!
//! Every option also reads an environment variable (the flag wins):
//! `LOGSVC_LISTEN` (or `PORT`, listening on 0.0.0.0), `LOGSVC_BACKEND`,
//! `LOGSVC_PG_URL`, `LOGSVC_POOL`, `LOGSVC_OBJECTS_DIR`, `LOGSVC_PUBLIC_BASE`.
//!
//! Keys come from the environment (`LOGSVC_ROOT_KEYS`, `LOGSVC_TOKEN_ISSUERS`:
//! comma-separated hex Ed25519 public keys; `LOGSVC_URL_SECRET`: ≥ 32 bytes hex).
//! `--testkit-cp LABEL --insecure-test-keys` instead pins the deterministic test
//! control plane, for local tests and measurements only; it refuses a non-loopback
//! listener. Postgres must use TLS (`sslmode=require` or `verify-full` in the URL)
//! unless it is on loopback.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;

use mdbn_log_server::fs::FsObjects;
use mdbn_log_server::pg::PgBackend;
use mdbn_log_server::{AnyService, Gateway, pg_listener, serve, testkit_config};
use mdbn_log_service::Service;
use mdbn_log_service::mem::{MemBackend, MemObjects};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let env_of = |k: &str| match k {
        "--listen" => std::env::var("LOGSVC_LISTEN")
            .ok()
            .or_else(|| std::env::var("PORT").ok().map(|p| format!("0.0.0.0:{p}"))),
        "--backend" => std::env::var("LOGSVC_BACKEND").ok(),
        "--pg-url" => std::env::var("LOGSVC_PG_URL").ok(),
        "--pool" => std::env::var("LOGSVC_POOL").ok(),
        "--objects" => std::env::var("LOGSVC_OBJECTS_DIR").ok(),
        "--public-base" => std::env::var("LOGSVC_PUBLIC_BASE").ok(),
        _ => None,
    };
    let arg = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .or_else(|| env_of(k))
    };
    let listen = arg("--listen").unwrap_or_else(|| "127.0.0.1:7700".into());
    let backend = arg("--backend").unwrap_or_else(|| "mem".into());
    let label = arg("--testkit-cp");
    let base = arg("--public-base").unwrap_or_else(|| format!("http://{listen}"));
    let debug = args.iter().any(|a| a == "--debug-hooks");
    let loopback = listen.starts_with("127.")
        || listen.starts_with("localhost")
        || listen.starts_with("[::1]");
    // `/debug/*` deletes acknowledged items: test-only, exactly like test keys.
    if debug && (!loopback || !args.iter().any(|a| a == "--insecure-test-keys")) {
        panic!("--debug-hooks needs --insecure-test-keys and a loopback listener");
    }
    let config = match label {
        Some(label) => {
            if !args.iter().any(|a| a == "--insecure-test-keys") || !loopback {
                panic!("--testkit-cp needs --insecure-test-keys and a loopback listener");
            }
            eprintln!("WARNING: deterministic test keys ({label}); never use with real data");
            testkit_config(&label, &base)
        }
        None => {
            let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is required"));
            mdbn_log_service::Config::from_hex(
                &env("LOGSVC_ROOT_KEYS"),
                &env("LOGSVC_TOKEN_ISSUERS"),
                &env("LOGSVC_URL_SECRET"),
                &base,
            )
            .unwrap_or_else(|e| panic!("config: {e}"))
        }
    };
    let listener = tokio::net::TcpListener::bind(&listen).await.expect("bind");
    let gw = match backend.as_str() {
        "mem" => Gateway::new(
            AnyService::Mem(Service::new(
                MemBackend::default(),
                MemObjects::default(),
                config,
            )),
            debug,
        ),
        "pg" => {
            let url = arg("--pg-url").expect("--pg-url");
            let pool: usize = arg("--pool").and_then(|p| p.parse().ok()).unwrap_or(32);
            let objects = PathBuf::from(arg("--objects").expect("--objects"));
            let mut be = loop {
                match PgBackend::connect(&url, pool).await {
                    Ok(b) => break b,
                    Err(e) => {
                        eprintln!("waiting for postgres: {e}");
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            };
            if args.iter().any(|a| a == "--notify-in-txn") {
                be.notify = mdbn_log_server::pg::NotifyMode::InTransaction;
            }
            let gw = Gateway::new(
                AnyService::Pg(Service::new(be, FsObjects::new(objects), config)),
                debug,
            );
            let g = gw.clone();
            tokio::spawn(async move {
                loop {
                    if let Err(e) = pg_listener(g.clone(), url.clone()).await {
                        eprintln!("listener: {e}; reconnecting");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            });
            gw
        }
        other => panic!("unknown backend {other}"),
    };
    eprintln!("logsvc listening on {listen} ({backend})");
    serve(gw, listener).await.expect("serve");
}
