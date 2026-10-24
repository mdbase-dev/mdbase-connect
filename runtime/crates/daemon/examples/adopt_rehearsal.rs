//! Adopt rehearsal (test tooling, never shipped): adopt a folder with files into a
//! log on an external loopback log service across process restarts, so a driver
//! can kill -9 the adopter at any point and check that a rerun converges.
//!
//! ```text
//! logsvc --listen 127.0.0.1:7741 --testkit-cp conformance --insecure-test-keys &
//! export MDBASE_ENV=test MDBASE_SECRET_BACKEND=insecure-test-file
//! adopt_rehearsal setup  --log http://127.0.0.1:7741 --dir <run> --docs 3000 [--cloud]
//! adopt_rehearsal adopt  --dir <run> [--exit-when-done]   # kill -9 it, run again
//! adopt_rehearsal verify --dir <run>
//! ```
//!
//! Secrets live in the insecure test file store under `<run>`; the example refuses
//! to run without both test variables (never the OS keychain).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "../tests/fixtures/adopt.rs"]
mod scenario;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn flag(name: &str) -> bool {
    std::env::args().any(|a| a == name)
}

fn secrets(dir: &Path) -> Arc<dyn mdbn_daemon::secrets::SecretStore> {
    std::fs::create_dir_all(dir).unwrap();
    let s: Arc<dyn mdbn_daemon::secrets::SecretStore> = Arc::from(mdbn_daemon::secrets::store_for(
        "mdbase-adopt-rehearsal",
        dir,
    ));
    assert_eq!(
        s.backend(),
        "insecure-test-file",
        "set MDBASE_ENV=test MDBASE_SECRET_BACKEND=insecure-test-file"
    );
    s
}

fn digest(snap: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, String> {
    snap.iter()
        .map(|(p, b)| {
            (
                p.clone(),
                mdbn_daemon::secrets::hex(&mdbn_wire::hash::sha256(b).0),
            )
        })
        .collect()
}

fn plan(dir: &Path) -> scenario::Plan {
    serde_json::from_slice(&std::fs::read(dir.join("plan.json")).expect("plan.json")).unwrap()
}

fn ms(t0: Instant) -> u128 {
    t0.elapsed().as_millis()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()))
        .init();
    let dir = PathBuf::from(arg("--dir").expect("--dir"));
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let t0 = Instant::now();
    match cmd.as_str() {
        "setup" => {
            let log = arg("--log").expect("--log");
            let docs: usize = arg("--docs").map(|d| d.parse().unwrap()).unwrap_or(1000);
            std::fs::create_dir_all(&dir).unwrap();
            let ids = scenario::fill_folder(&dir.join("a"), docs);
            let before = digest(&scenario::snapshot(&dir.join("a")));
            let p = scenario::create(&log, ids, !flag("--cloud")).await;
            std::fs::write(dir.join("plan.json"), serde_json::to_vec(&p).unwrap()).unwrap();
            std::fs::write(
                dir.join("before.json"),
                serde_json::to_vec(&before).unwrap(),
            )
            .unwrap();
            println!(
                "SETUP collection={} docs={docs} files={} private={}",
                mdbn_wire::common::B16(p.collection).to_uuid_string(),
                before.len(),
                p.private
            );
        }
        "adopt" => {
            let p = plan(&dir);
            let rt = scenario::open(
                &p,
                "desktop-a",
                &dir.join("a"),
                &dir.join("a-state"),
                secrets(&dir.join("a-secrets")),
                true,
            );
            println!("OPEN {}ms", ms(t0));
            let mut last = String::new();
            loop {
                let (s, _, adopt) = rt.readiness().await.expect("runtime stopped");
                let now = format!(
                    "{:?} confirmed={} pending={} holds={}",
                    adopt, s.confirmed_through, s.pending, s.holds
                );
                if now != last {
                    println!("STATUS {}ms {now}", ms(t0));
                    last = now;
                }
                match adopt {
                    Some(mdbn_replica::AdoptStatus::Failed(why)) => {
                        println!("FAILED {why}");
                        std::process::exit(2);
                    }
                    Some(mdbn_replica::AdoptStatus::Pending) => {}
                    _ => break,
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            scenario::records(&rt, &p.records, Duration::from_secs(600)).await;
            println!("ADOPTED {}ms", ms(t0));
            if flag("--exit-when-done") {
                // Let what is ingested after the base (the attachment) reach the log:
                // nothing pending and the log position unchanged for 10 s (an
                // attachment is captured and uploaded before it counts as pending).
                let deadline = Instant::now() + Duration::from_secs(300);
                let (mut seen, mut since) = (0, Instant::now());
                while Instant::now() < deadline {
                    let Some(s) = rt.status().await else { break };
                    if s.pending > 0 || s.confirmed_through != seen {
                        (seen, since) = (s.confirmed_through, Instant::now());
                    } else if since.elapsed() >= Duration::from_secs(10) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                println!("SETTLED {}ms confirmed={seen}", ms(t0));
                rt.stop().await;
                println!("STOPPED {}ms", ms(t0));
            } else {
                loop {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                }
            }
        }
        "verify" => {
            let p = plan(&dir);
            let before: BTreeMap<String, String> =
                serde_json::from_slice(&std::fs::read(dir.join("before.json")).unwrap()).unwrap();
            let after = digest(&scenario::snapshot(&dir.join("a")));
            assert_eq!(after, before, "the adopted folder changed");
            println!(
                "PASS: adopted folder bytes unchanged ({} files)",
                after.len()
            );
            let (label, store) = if p.private {
                ("desktop-a", secrets(&dir.join("a-secrets")))
            } else {
                ("desktop-b", secrets(&dir.join("b-secrets")))
            };
            let tag = std::process::id();
            let second = dir.join(format!("second-{tag}"));
            let rt = scenario::open(
                &p,
                label,
                &second,
                &dir.join(format!("second-{tag}-state")),
                store,
                false,
            );
            scenario::records(&rt, &p.records, Duration::from_secs(600)).await;
            println!(
                "PASS: second replica ({label}) holds all {} record IDs ({}ms)",
                p.records.len(),
                ms(t0)
            );
            let want: BTreeMap<String, Vec<u8>> = scenario::snapshot(&dir.join("a"));
            scenario::files(&second, &want, Duration::from_secs(600)).await;
            println!(
                "PASS: second replica's folder is byte-identical ({}ms)",
                ms(t0)
            );
            let st = rt.status().await.unwrap();
            println!(
                "STATUS second confirmed={} holds={} unresolved={}",
                st.confirmed_through, st.holds, st.unresolved
            );
            assert_eq!((st.holds, st.unresolved), (0, 0));
            rt.stop().await;
        }
        _ => panic!("usage: adopt_rehearsal setup|adopt|verify --dir <run> ..."),
    }
}
