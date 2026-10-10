//! Test helpers. Scratch directories live under the workspace `target/`, never
//! `/tmp` (AGENTS.md).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A fresh directory under `target/t/`, removed on drop.
pub struct TestDir(PathBuf);

impl TestDir {
    /// Create `target/t/<tag>-<pid>-<n>`. Kept short: Unix socket paths are
    /// limited to about 100 bytes.
    pub fn new(tag: &str) -> TestDir {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/t")
            .join(format!("{tag}-{}-{n}", std::process::id()));
        let p = std::path::absolute(&p).unwrap();
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TestDir(p)
    }

    /// The path.
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
