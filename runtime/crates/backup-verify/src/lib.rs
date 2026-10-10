//! Offline authenticated native backup verification.
//!
//! Responsibility: verify exact cut/completion bytes against independently
//! supplied trust, without I/O in this library or any current-authority claim.
//! Allowed internal dependencies: mdbn-wire and mdbn-log-service only. Native
//! only; not linked into a WASM or application composition root.
#![cfg(not(target_arch = "wasm32"))]

mod completion;
mod header;
mod memory;
mod memory_vec;
mod pages;
mod rows;
mod verifier;

pub use memory::OwnedBytes;
pub use verifier::{CutVerifier, Verified};

#[cfg(test)]
#[path = "cli/args.rs"]
mod cli_args;

/// Content-free refusal categories frozen by the native verifier contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Malformed, unknown, duplicate or missing CLI options.
    Invocation,
    /// Input I/O or stable-file identity checks failed or are unsupported.
    Io,
    /// A fixed size/count/work/memory or arithmetic bound was exceeded.
    Bounds,
    /// File names, kinds or complete inventory do not match the whitelist.
    Layout,
    /// Canonical CBOR framing, keys or typed values were rejected.
    Canonical,
    /// Independently supplied purpose, scope or capture trust did not match.
    Trust,
    /// Completion, signed history or manifest signature did not verify.
    Signature,
    /// Header, FINISH or completion bindings did not match.
    Binding,
    /// Page chain, order, sections, cursors or terminals did not match.
    Pages,
    /// Signed replay, sequence, compaction, policy or chain was rejected.
    History,
    /// Inventory roots, counts or accounting did not match.
    Inventory,
    /// Sealed object kind, size, checksum or address did not match.
    Objects,
    /// Expanded snapshot reference closure did not match.
    Refs,
}

impl Refusal {
    /// Exact fixed label; never includes paths, identifiers or source errors.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invocation => "invocation",
            Self::Io => "io",
            Self::Bounds => "bounds",
            Self::Layout => "layout",
            Self::Canonical => "canonical",
            Self::Trust => "trust",
            Self::Signature => "signature",
            Self::Binding => "binding",
            Self::Pages => "pages",
            Self::History => "history",
            Self::Inventory => "inventory",
            Self::Objects => "objects",
            Self::Refs => "refs",
        }
    }

    /// Exact handled CLI exit code (zero is reserved for verified success).
    pub const fn exit_code(self) -> u8 {
        match self {
            Self::Invocation | Self::Io | Self::Bounds => 2,
            _ => 1,
        }
    }

    /// The complete bounded refusal line, including its trailing newline.
    pub fn json_line(self) -> String {
        format!("{{\"verified\":false,\"code\":\"{}\"}}\n", self.code())
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for Refusal {}

#[cfg(test)]
mod tests {
    use super::Refusal::*;

    #[test]
    fn fixed_refusal_labels_and_exit_mapping_are_content_free() {
        let cases = [
            (Invocation, "invocation", 2),
            (Io, "io", 2),
            (Bounds, "bounds", 2),
            (Layout, "layout", 1),
            (Canonical, "canonical", 1),
            (Trust, "trust", 1),
            (Signature, "signature", 1),
            (Binding, "binding", 1),
            (Pages, "pages", 1),
            (History, "history", 1),
            (Inventory, "inventory", 1),
            (Objects, "objects", 1),
            (Refs, "refs", 1),
        ];
        for (refusal, code, exit) in cases {
            assert_eq!(refusal.code(), code);
            assert_eq!(refusal.exit_code(), exit);
            assert_eq!(refusal.to_string(), code);
            let line = refusal.json_line();
            assert_eq!(
                line,
                format!("{{\"verified\":false,\"code\":\"{code}\"}}\n")
            );
            assert!(line.len() <= 256);
        }
    }
}
