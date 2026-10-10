//! CLI-only directory checks remain outside the pure verification library.
#![cfg(not(target_arch = "wasm32"))]
#[path = "../src/cli/files.rs"]
mod files;
#[path = "../src/cli/layout.rs"]
mod layout;
