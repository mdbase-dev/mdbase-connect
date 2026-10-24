//! Test the CLI-only reader without adding filesystem I/O to the pure library.
#![cfg(not(target_arch = "wasm32"))]
#[path = "../src/cli/files.rs"]
mod files;
