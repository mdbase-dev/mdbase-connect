//! `logsvc-bench`: D2 measurements against any log service URL.
//!
//! ```text
//! logsvc-bench --url http://127.0.0.1:7700 contention --writers 8 --secs 20
//! logsvc-bench --url ... scale --collections 100 --secs 20
//! logsvc-bench --url ... fanout --subscribers 50 --items 100
//! logsvc-bench --url ... blob --parts 16 --mib 8 --conc 4
//! logsvc-bench --url ... recovery --secs 60
//! logsvc-bench --url ... conformance [--hooks]
//! ```
//! Prints one JSON line per run.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use mdbn_log_conformance::Target;
use mdbn_log_conformance::bench;
use mdbn_log_conformance::suite::{report, run};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str, d: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| d.to_string())
    };
    let n = |k: &str, d: usize| arg(k, &d.to_string()).parse::<usize>().unwrap();
    let url = arg("--url", "http://127.0.0.1:7700");
    let t = Target {
        name: url.clone(),
        ws: url.replacen("http", "ws", 1),
        http: url.clone(),
        debug_hooks: args.iter().any(|a| a == "--hooks"),
    };
    let scenario = args
        .iter()
        .skip(1)
        .find(|a| {
            [
                "contention",
                "scale",
                "fanout",
                "blob",
                "recovery",
                "conformance",
            ]
            .contains(&a.as_str())
        })
        .cloned()
        .unwrap_or_else(|| "contention".into());
    let r = match scenario.as_str() {
        "contention" => bench::contention(&t, n("--writers", 8), n("--secs", 20) as u64).await,
        "scale" => bench::scale(&t, n("--collections", 100), n("--secs", 20) as u64).await,
        "fanout" => bench::fanout(&t, n("--subscribers", 10), n("--items", 100)).await,
        "blob" => bench::blob(&t, n("--parts", 8), n("--mib", 8), n("--conc", 4)).await,
        "recovery" => bench::recovery(&t, n("--secs", 60) as u64).await,
        "conformance" => {
            let ok = report(
                &t,
                &run(
                    &t,
                    args.iter()
                        .position(|a| a == "--filter")
                        .and_then(|i| args.get(i + 1))
                        .map(|s| s.as_str()),
                )
                .await,
            );
            std::process::exit(if ok { 0 } else { 1 });
        }
        _ => unreachable!(),
    };
    match r {
        Ok(line) => println!("{line}"),
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    }
}
