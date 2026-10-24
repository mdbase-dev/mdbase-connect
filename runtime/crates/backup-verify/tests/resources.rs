#![cfg(all(
    not(target_arch = "wasm32"),
    target_os = "linux",
    target_pointer_width = "64"
))]
//! Test-only allocator/process evidence; production CLI has no profiling surface.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "Test-only allocator, process and RSS measurement"
)]
use mdbn_backup_verify::{CutVerifier, Refusal};
use mdbn_log_service::OfflineDecodeBudget;
#[path = "../src/cli/mod.rs"]
mod cli;
#[path = "support/cut.rs"]
mod cut;
#[path = "../src/memory_vec.rs"]
#[allow(dead_code)]
mod memory_vec;
#[path = "support/replay_resources.rs"]
mod replay_resources;
#[path = "support/stage.rs"]
mod stage;
mod memory {
    pub(crate) fn poison(work: &mdbn_log_service::OfflineDecodeBudget) {
        let _ = work.reserve_owned(u64::MAX);
    }
}
#[allow(unsafe_code)]
mod allocator {
    use std::{
        alloc::{GlobalAlloc, Layout, System},
        sync::atomic::{AtomicUsize, Ordering},
    };
    pub static LIVE: AtomicUsize = AtomicUsize::new(0);
    pub static PEAK: AtomicUsize = AtomicUsize::new(0);
    pub struct Meter;
    fn add(bytes: usize) {
        let live = LIVE.fetch_add(bytes, Ordering::SeqCst) + bytes;
        PEAK.fetch_max(live, Ordering::SeqCst);
    }
    // SAFETY: each operation delegates the unchanged ptr/layout to System. The
    // atomics are observations ONLY; never allocation/admission authority.
    unsafe impl GlobalAlloc for Meter {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc(layout) };
            if !ptr.is_null() {
                add(layout.size());
            }
            ptr
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc_zeroed(layout) };
            if !ptr.is_null() {
                add(layout.size());
            }
            ptr
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) };
            LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            let new = unsafe { System.realloc(ptr, layout, size) };
            if !new.is_null() {
                if size >= layout.size() {
                    add(size - layout.size());
                } else {
                    LIVE.fetch_sub(layout.size() - size, Ordering::SeqCst);
                }
            }
            new
        }
    }
}
#[global_allocator]
static METER: allocator::Meter = allocator::Meter;
mod process_rss {
    pub fn measure(stage: &super::stage::Stage, expected_exit: i32) -> u64 {
        // Execute a fresh small measurement process before it forks the CLI.
        // Measuring the first fork directly includes the fixture producer's
        // inherited resident pages, not only the executable being qualified.
        let path = stage.parent.join("test-only-rss.txt");
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "resource_measurement_child"])
            .env("MDBN_TEST_RESOURCE_STAGE", &stage.parent)
            .env("MDBN_TEST_RESOURCE_EXIT", expected_exit.to_string())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let rss = std::fs::read_to_string(&path)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::fs::remove_file(path).unwrap();
        rss
    }
}
// This fresh test process forks the product executable without ever building a
// large fixture. It writes only a test-only resource receipt beside the cut.
#[test]
#[ignore = "Invoked by the resource test in a fresh fixture-free process"]
#[allow(unsafe_code)]
fn resource_measurement_child() {
    use std::ffi::c_long;
    use std::process::{Command, Stdio};
    unsafe extern "C" {
        fn wait4(pid: i32, status: *mut i32, options: i32, usage: *mut c_long) -> i32;
    }
    let parent = std::path::PathBuf::from(std::env::var_os("MDBN_TEST_RESOURCE_STAGE").unwrap());
    let expected_exit: i32 = std::env::var("MDBN_TEST_RESOURCE_EXIT")
        .unwrap()
        .parse()
        .unwrap();
    #[allow(
        clippy::zombie_processes,
        reason = "Owned child is reaped by wait4 below"
    )]
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdbn-backup-verify"))
        .arg("--cut-dir")
        .arg(parent.join("cut"))
        .arg("--completion")
        .arg(parent.join("completion.cbor"))
        .arg("--trust")
        .arg(parent.join("trust.cbor"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = i32::try_from(child.id()).unwrap();
    let mut status = 0;
    let mut usage = [0 as c_long; 18]; // Complete Linux64 struct rusage.
    for _ in 0..32 {
        // SAFETY: owned live child pid and aligned, complete writable storage.
        let waited = unsafe { wait4(pid, &mut status, 0, usage.as_mut_ptr()) };
        if waited == pid {
            break;
        }
        assert_eq!(
            std::io::Error::last_os_error().kind(),
            std::io::ErrorKind::Interrupted
        );
    }
    assert_eq!(status, expected_exit << 8);
    assert!(usage[4] > 0);
    let mut output = Vec::new();
    use std::io::Read;
    child
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut output)
        .unwrap();
    assert!(output.len() <= 256);
    let mut error = Vec::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut error)
        .unwrap();
    assert!(error.is_empty());
    if expected_exit == 0 {
        assert!(output.starts_with(b"{\"verified\":true,"));
        assert!(output.ends_with(b"\"current_authority_verified\":false}\n"));
    } else {
        assert_eq!(output, b"{\"verified\":false,\"code\":\"bounds\"}\n");
    }
    std::fs::write(parent.join("test-only-rss.txt"), usage[4].to_string()).unwrap();
}

#[test]
fn measured_cli_allocations_rss_and_hard_shared_owned_refusal() {
    use std::sync::atomic::Ordering;
    for (name, compacted, indexed, large) in [
        ("ordinary", false, false, false),
        ("compacted", true, false, false),
        ("indexed", false, true, false),
        ("near9", false, false, true),
        ("near9_manifest", false, false, false),
    ] {
        let fixture = if name == "near9_manifest" {
            cut::resource_manifest_fixture()
        } else {
            cut::fixture(compacted, indexed, large)
        };
        let stage = stage::Stage::new(&fixture);
        drop(fixture);
        let baseline = allocator::LIVE.load(Ordering::SeqCst);
        allocator::PEAK.store(baseline, Ordering::SeqCst);
        let result = cli::run(stage.arguments().into_iter());
        assert!(result.is_ok());
        let peak = allocator::PEAK.load(Ordering::SeqCst);
        assert!(peak.saturating_sub(baseline) <= 96 * 1024 * 1024);
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        let hwm = status
            .lines()
            .find(|line| line.starts_with("VmHWM:"))
            .unwrap();
        println!(
            "RESOURCE case={name} baseline_bytes={baseline} allocator_peak_bytes={peak} incremental_peak_bytes={} process_{hwm}",
            peak.saturating_sub(baseline)
        );
        // Actual separate executable RSS, not test-runner VmHWM.
        let rss = process_rss::measure(&stage, 0);
        println!("RESOURCE case={name} actual_cli_maxrss_kib={rss}");
    }
    // Exercise simultaneous identity/index/snapshot/decoder lifetimes, not only
    // a large payload in an otherwise tiny cut. Refusal is an explicit bound,
    // never a truncated successful inventory.
    for (name, snapshots, members, indices, large, expected_exit) in [
        ("snapshot64_overlap32", 64, 126, 32, false, 0),
        ("index3002_overlap32", 2, 3000, 32, false, 0),
        ("index8192_overlap32", 2, 8190, 32, false, 0),
        ("near9_snapshot64_overlap32", 64, 126, 32, true, 0),
        ("near9_index3002_overlap32", 2, 3000, 32, true, 0),
        ("near9_index8192_overlap32_refusal", 2, 8190, 32, true, 2),
        ("snapshot65_refusal", 65, 0, 0, false, 2),
        (
            "near9_snapshot64_index3002_memory_refusal",
            64,
            3000,
            32,
            true,
            2,
        ),
        ("snapshot64_index8192_refusal", 64, 8190, 32, true, 2),
    ] {
        let fixture = cut::resource_fixture(snapshots, members, indices, large);
        if name == "index3002_overlap32" {
            let work = OfflineDecodeBudget::new();
            let mut feed = CutVerifier::new(&fixture.trust, &fixture.completion, &work).unwrap();
            feed.bind_header(&fixture.header, &fixture.finish).unwrap();
            for (number, page) in fixture.pages.iter().enumerate() {
                assert!(feed.push_page(page).is_ok(), "diagnostic page {number}");
            }
            feed.finish_pages().unwrap();
            for (number, (address, bytes)) in fixture.objects.iter().enumerate() {
                let result = feed.push_object(address, bytes);
                assert!(result.is_ok(), "diagnostic object {number}: {result:?}");
            }
            assert!(feed.finish().is_ok(), "diagnostic final inventory");
        }
        let stage = stage::Stage::new(&fixture);
        drop(fixture);
        let baseline = allocator::LIVE.load(Ordering::SeqCst);
        allocator::PEAK.store(baseline, Ordering::SeqCst);
        let result = cli::run(stage.arguments().into_iter());
        if expected_exit == 0 {
            assert!(result.is_ok(), "{name}: unexpected refusal");
        } else {
            assert!(
                matches!(result, Err(Refusal::Bounds)),
                "{name}: expected bounds refusal"
            );
        }
        let peak = allocator::PEAK
            .load(Ordering::SeqCst)
            .saturating_sub(baseline);
        assert!(
            peak <= 96 * 1024 * 1024,
            "{name}: actual owned allocations exceeded hard ceiling"
        );
        let rss = process_rss::measure(&stage, expected_exit);
        println!(
            "RESOURCE case={name} snapshots={snapshots} index_members={} indices={indices} near9={large} exit={expected_exit} incremental_peak_bytes={peak} actual_cli_maxrss_kib={rss}",
            members + 2
        );
    }
    let cut = cut::fixture(false, false, false);
    let work = OfflineDecodeBudget::new();
    let held = work.reserve_owned(95 * 1024 * 1024).unwrap();
    assert!(matches!(
        CutVerifier::new(&cut.trust, &cut.completion, &work),
        Err(Refusal::Bounds)
    ));
    drop(held);
    assert!(work.reserve_owned(0).is_err());
    println!("RESOURCE hard_owned_refusal=pass ceiling_bytes=100663296 poison_after_release=true");
    replay_resources::measure();
}
