//! Owned disposable local TEST filesystem only; no deployed environment data.
#![allow(
    clippy::disallowed_methods,
    reason = "Disposable local filesystem fixtures"
)]
use super::cut::Cut;
use std::{
    ffi::OsString,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(crate) struct Stage {
    pub(crate) parent: PathBuf,
    pub(crate) root: PathBuf,
}
impl Stage {
    pub(crate) fn new(cut: &Cut) -> Self {
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join(format!(
                ".cli-fixture-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&parent).unwrap();
        let root = parent.join("cut");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("pages")).unwrap();
        fs::create_dir(root.join("objects")).unwrap();
        fs::write(parent.join("trust.cbor"), &cut.trust).unwrap();
        fs::write(parent.join("completion.cbor"), &cut.completion).unwrap();
        fs::write(root.join("header.cbor"), &cut.header).unwrap();
        fs::write(root.join("finish.cbor"), &cut.finish).unwrap();
        for (index, page) in cut.pages.iter().enumerate() {
            fs::write(
                root.join("pages").join(format!("{:010}.cbor", index + 1)),
                page,
            )
            .unwrap();
        }
        for (address, raw) in &cut.objects {
            fs::write(
                root.join("objects")
                    .join(format!("{}.cbor", address.to_hex())),
                raw,
            )
            .unwrap();
        }
        Self { parent, root }
    }
    pub(crate) fn arguments(&self) -> Vec<OsString> {
        vec![
            "--cut-dir".into(),
            self.root.as_os_str().into(),
            "--completion".into(),
            self.parent.join("completion.cbor").into_os_string(),
            "--trust".into(),
            self.parent.join("trust.cbor").into_os_string(),
        ]
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.parent);
    }
}
