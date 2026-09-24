#[cfg(target_os = "linux")]
#[test]
#[ignore = "synthetic idle observation; run optimized and single-threaded"]
fn benchmark_finalizer_service_idle() {
    fn cpu_ticks() -> u64 {
        let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
        let fields: Vec<_> = stat
            .rsplit_once(')')
            .unwrap()
            .1
            .split_whitespace()
            .collect();
        fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap()
    }
    let clock = std::process::Command::new("getconf")
        .arg("CLK_TCK")
        .output()
        .unwrap();
    assert!(clock.status.success());
    let ticks_per_second: u64 = String::from_utf8(clock.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    for count in [1, 8] {
        for round in 0..3 {
            let root = tempfile::tempdir().unwrap();
            let registry = CollectionRegistry::open(root.path().join("state")).unwrap();
            for index in 0..count {
                registry
                    .create(root.path().join(format!("notes-{index}")), None, "UTC")
                    .unwrap();
            }
            let service = CollectionWatchService::start(registry.clone());
            service.refresh(&registry.list().unwrap());
            std::thread::sleep(Duration::from_millis(300));
            let cpu = cpu_ticks();
            let start = std::time::Instant::now();
            std::thread::sleep(Duration::from_secs(3));
            println!(
                "FINALIZER_IDLE {}",
                serde_json::json!({
                    "collections":count, "round":round, "cpu_ticks":cpu_ticks()-cpu,
                    "wall_ms":start.elapsed().as_secs_f64()*1000.0,
                    "clock_ticks_per_second":ticks_per_second,
                })
            );
            drop(service);
        }
    }
}
