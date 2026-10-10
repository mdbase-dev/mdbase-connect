//! Diagnose a cold open: open the native local stack over a folder (no host
//! lock, own state dir), rescan, and report faults with the replica's
//! incidents and stats after every settle round.
//!
//! `mdbn-probe-open <corpus-dir> [--touch-type]` (needs no host lock: run it only
//! on a synthetic corpus, never a real vault).
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_local_host::host::{OsEntropy, SystemClock, now_ms};
use mdbn_local_host::{Identity, LocalReplica, ReplicaOptions, StoreOptions, open_store};

fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("corpus dir"));
    let opts = StoreOptions::default();
    let state = opts.state_dir(&root);
    let _ = std::fs::remove_dir_all(&state);
    std::fs::create_dir_all(&state).unwrap();
    let id =
        Identity::load_or_create(&state.join("identity.json"), now_ms(), &mut OsEntropy).unwrap();
    let t = std::time::Instant::now();
    let store = open_store(&root, &opts, Box::new(SystemClock)).unwrap();
    eprintln!("open_store {:?}", t.elapsed());
    let mut rep = LocalReplica::open(store, &id, ReplicaOptions::default()).unwrap();
    eprintln!("replica open {:?}", t.elapsed());
    rep.replica().store_mut().request_rescan();
    for round in 0..100_000u64 {
        let r = rep.observe();
        let r2 = rep.replica_ref();
        if r.is_err() || r2.requires_reopen() || round % 50 == 0 {
            eprintln!(
                "round {round} t={:?} observe={:?} reopen={} status={:?} stats={:?}",
                t.elapsed(),
                r.as_ref().err(),
                r2.requires_reopen(),
                r2.sync_status(),
                r2.stats
            );
        }
        if r.is_err() || r2.requires_reopen() {
            std::process::exit(1);
        }
        match rep.next_wakeup_ms() {
            None => break,
            Some(next) => {
                let now = now_ms();
                if next > now {
                    std::thread::sleep(std::time::Duration::from_millis(
                        (next - now).clamp(1, 250),
                    ));
                }
            }
        }
    }
    eprintln!(
        "settled {:?} status={:?}",
        t.elapsed(),
        rep.replica_ref().sync_status()
    );
    if std::env::args().nth(2).as_deref() == Some("--touch-type") {
        // Change the task type (every task record re-types) and rescan.
        let p = root.join("_types/task.md");
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(
            &p,
            text.replace(
                "      priority: { type: string }",
                "      priority: { type: string }\n      estimate: { type: integer }",
            ),
        )
        .unwrap();
        let t = std::time::Instant::now();
        let res = rep.rescan();
        let r = rep.replica_ref();
        eprintln!(
            "type change: {:?} res={res:?} reopen={} status={:?}",
            t.elapsed(),
            r.requires_reopen(),
            r.sync_status()
        );
    }
}
