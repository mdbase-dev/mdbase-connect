//! # mdbase-wasm: `mdbase-core.wasm`, the pure helpers for JavaScript
//!
//! **Responsibility.** Exposes the parts of [`mdbn_core`] that applications use
//! outside a collection runtime, as pure functions over JSON: contract and
//! implementation digests, JSON Schema compilation and validation, catalog
//! (config, types, contracts) loading, record validation, query checking and
//! type-pack assess/apply. The npm package `mdbase` (`packages/mdbase`) wraps
//! this module; `mdbase-reader`, `mdbase-writer` and app scripts call it where
//! they called `@callumalpass/mdbase` before.
//!
//! Every operation is `call(op, input_json) -> output_json`. The output is
//! `{"ok": …}` or `{"error": {"code", "message", "location"?, "details"?}}`.
//! The same [`call`] runs natively, so the tests and the conformance digests are
//! checked without a WASM host.
//!
//! **ABI** (wasm32 only; the memory convention of `runtime.wasm`):
//! - `alloc(len) -> ptr` and `dealloc(ptr, len)`;
//! - `mdbase_abi() -> u32`: the ABI major, `1`;
//! - `mdbase_call(op_ptr, op_len, in_ptr, in_len) -> u64`: both inputs come from
//!   `alloc` and are consumed; the output is UTF-8 JSON packed as
//!   `(ptr << 32) | len`, freed by the host with `dealloc`.
//!
//! No imports: the helpers never read a clock or entropy.
//!
//! **Rules.** Portable like `mdbn-core`: no I/O, no hash containers.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`.

pub mod json;
pub mod ops;

use serde_json::json;

/// The ABI major version of `mdbase_call`.
pub const ABI_MAJOR: u32 = 1;

/// Run `op` on the JSON text `input` and return the JSON text of the result:
/// `{"ok": …}` or `{"error": {"code", "message", …}}`.
///
/// ```
/// let out = mdbase_wasm::call("info", "{}");
/// let v: serde_json::Value = serde_json::from_str(&out).unwrap();
/// assert_eq!(v["ok"]["abi"], 1);
/// ```
pub fn call(op: &str, input: &str) -> String {
    let input = match serde_json::from_str::<serde_json::Value>(input) {
        Ok(v) => v,
        Err(e) => {
            return json!({"error": {"code": "invalid_json", "message": format!("the input is not JSON: {e}")}})
                .to_string();
        }
    };
    match ops::dispatch(op, &input) {
        Ok(v) => json!({ "ok": v }).to_string(),
        Err(e) => json!({ "error": e.to_json() }).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod abi {
    /// Allocate `len` bytes for the host to write into.
    #[unsafe(no_mangle)]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut v = std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(len));
        v.as_mut_ptr()
    }

    /// Free memory returned by [`alloc`] or by an output pointer.
    ///
    /// # Safety
    /// `ptr` and `len` must come from `alloc(len)` or a returned output.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }

    /// The ABI major version.
    #[unsafe(no_mangle)]
    pub extern "C" fn mdbase_abi() -> u32 {
        super::ABI_MAJOR
    }

    /// Run an operation. Both inputs are consumed; the output is packed as
    /// `(ptr << 32) | len`.
    ///
    /// # Safety
    /// Both pointers must come from `alloc` with the given lengths and hold
    /// initialised bytes.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn mdbase_call(
        op_ptr: *mut u8,
        op_len: usize,
        in_ptr: *mut u8,
        in_len: usize,
    ) -> u64 {
        let op = unsafe { Vec::from_raw_parts(op_ptr, op_len, op_len) };
        let input = unsafe { Vec::from_raw_parts(in_ptr, in_len, in_len) };
        let out = match (String::from_utf8(op), String::from_utf8(input)) {
            (Ok(op), Ok(input)) => super::call(&op, &input),
            _ => {
                r#"{"error":{"code":"invalid_utf8","message":"the input is not UTF-8"}}"#.to_owned()
            }
        };
        let bytes = std::mem::ManuallyDrop::new(out.into_bytes().into_boxed_slice());
        ((bytes.as_ptr() as u64) << 32) | (bytes.len() as u64)
    }
}
