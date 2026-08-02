use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

mod applications;
mod collections;
mod connect_problems_generated;
mod control;
pub mod crypto;
mod file_crypto;
mod files;
mod first_contact;
mod relay;
mod sync;

pub use applications::*;
pub use collections::*;
pub use connect_problems_generated::*;
pub use control::*;
pub use file_crypto::*;
pub use files::*;
pub use first_contact::*;
pub use relay::*;
pub use sync::*;
pub const CONTROL_PROTOCOL_VERSION: u32 = 1;
pub const LOCAL_CONTROL_PROTOCOL_VERSION: u32 = 2;
pub const ENCRYPTED_RELAY_PROTOCOL_VERSION: u32 = 1;
pub const FIRST_CONTACT_PROTOCOL_VERSION: u32 = 1;
pub const LOOPBACK_PROTOCOL_VERSION: u32 = 1;
pub const DEFAULT_LOOPBACK_PORT: u16 = 28_485;
pub const SYNC_PROTOCOL_VERSION: u32 = 1;
pub const RELAY_HANDSHAKE_TIMEOUT_SECONDS: u64 = 5;
pub const RELAY_INCOMPATIBLE_CLOSE_CODE: u16 = 4406;
pub const CONTRACT_SETUP_CAPABILITY: &str = "contract-setup-v1";
pub const FILE_RELAY_CAPABILITY: &str = "file-relay-v1";
pub const RELAY_REQUIRED_CAPABILITIES: &[&str] = &[
    "application-trust-v1",
    "authorization-activation",
    "encrypted-relay",
    "policy-ack",
];
pub const RELAY_CAPABILITIES: &[&str] = &[
    "application-trust-v1",
    "authorization-activation",
    "encrypted-relay",
    "policy-ack",
    CONTRACT_SETUP_CAPABILITY,
    FILE_RELAY_CAPABILITY,
];
pub const RELAY_ENCRYPTION_SUITE: &str = "P256-HKDF-SHA256-AES256GCM";
pub const AUTHORITY_PROOF_VERSION: u32 = 1;
pub const AUTHORITY_PROOF_ALGORITHM: &str = "P256-SHA256";
pub const AUTHORITY_PROOF_DOMAIN: &str = "mdbase-authority-request-proof-v1";
pub const AUTHORITY_PROOF_VERSION_HEADER: &str = "x-mdbase-proof-version";
pub const AUTHORITY_PROOF_TIMESTAMP_HEADER: &str = "x-mdbase-proof-timestamp";
pub const AUTHORITY_PROOF_NONCE_HEADER: &str = "x-mdbase-proof-nonce";
pub const AUTHORITY_PROOF_SIGNATURE_HEADER: &str = "x-mdbase-proof-signature";

#[cfg(test)]
mod tests;
