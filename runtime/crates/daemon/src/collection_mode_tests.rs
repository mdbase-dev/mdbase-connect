use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Disk(std::path::PathBuf);
impl Disk {
    fn new() -> Self {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target")
            .join(format!(
                "mode-request-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Disk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn request() -> Request {
    Request {
        collection: "11111111-1111-4111-8111-111111111111".into(),
        account: "22222222-2222-4222-8222-222222222222".into(),
        device: "33333333-3333-4333-8333-333333333333".into(),
        genesis: "ab".repeat(32),
        generation: "cd".repeat(32),
        request: "44444444-4444-4444-8444-444444444444".into(),
        target: "cloud_copy".into(),
        cancel_requested: false,
        native_started: false,
    }
}
#[test]
fn unknown_http_outcome_keeps_exact_request_and_generation_after_reopen() {
    let disk = Disk::new();
    let original = request();
    original.save(&disk.0).unwrap();
    let reopened = Request::load(&disk.0).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&original).unwrap(),
        serde_json::to_value(reopened).unwrap()
    );
}
#[test]
fn cancellation_is_durable_before_http_and_clear_is_idempotent() {
    let disk = Disk::new();
    let mut op = request();
    op.save(&disk.0).unwrap();
    op.cancel_requested = true;
    op.save(&disk.0).unwrap();
    assert!(Request::load(&disk.0).unwrap().unwrap().cancel_requested);
    Request::clear(&disk.0).unwrap();
    Request::clear(&disk.0).unwrap();
    assert!(Request::load(&disk.0).unwrap().is_none());
}
#[test]
fn corrupt_or_unbound_journals_fail_closed_and_are_retained() {
    let disk = Disk::new();
    for field in [
        "account",
        "device",
        "collection",
        "request",
        "genesis",
        "generation",
        "target",
    ] {
        let mut value = serde_json::to_value(request()).unwrap();
        value[field] = serde_json::Value::String("invalid".into());
        crate::fsutil::write_atomic(&disk.0.join(FILE), &serde_json::to_vec(&value).unwrap())
            .unwrap();
        assert!(Request::load(&disk.0).is_err(), "{field}");
        assert!(disk.0.join(FILE).exists());
    }
    crate::fsutil::write_atomic(&disk.0.join(FILE), b"{").unwrap();
    assert!(Request::load(&disk.0).is_err());
    assert!(disk.0.join(FILE).exists());
}
