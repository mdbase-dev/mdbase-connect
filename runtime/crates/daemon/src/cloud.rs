//! The account link: pairing as a connector, device registration, inventory,
//! grant revocation and the synced-collection bootstrap calls (cloud copy and
//! private create/join, role-0 log tokens) over Connect's HTTP API. Every
//! device-signed proof digest is the shared [`mdbn_replica::crypto::proof`] one
//! (control interface note `2026-10-04-control-daemon-grant-feed-and-relay.md` §1;
//! Connect #595, #616, #621, #624).
//!
//! **State.** `<state>/cloud.json` holds the non-secret part
//! ([`CloudConfig`]: server URL, connector ID and registration flag). The durable
//! policy cursor is committed with the access cache in `access.json`. The connector token lives in the OS keychain
//! (`<namespace>:connector-token`) and never appears in files, logs, status or
//! process arguments.
//!
//! **TLS** uses rustls with the OS trust store (`rustls-native-certs`). Plain
//! `http` is accepted only for loopback hosts (tests and LAB tunnels).

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use mdbn_replica::crypto::proof;
use mdbn_wire::common::B16;

use crate::fsutil;
use crate::secrets::{self, DeviceIdentity, SecretStore};

#[path = "cloud_approval_peer.rs"]
mod approval_peer;
pub use approval_peer::{ApprovalPeerCandidate, ApprovalPeerQueued};

mod account_key;
mod collections;
mod config;
mod connector;
mod mode;
mod rollout;
mod transport;

#[cfg(test)]
use rollout::*;
use transport::*;

pub use account_key::{AccountKeyRecord, RecoveryDevices};
pub use collections::{Created, Joined};
pub use config::{AccountRecord, CloudConfig};
pub use connector::{
    AccountApplication, AccountApplicationCollection, AppDistribution, Paired, Pairing,
    device_bind_sig, pairing_exchange, pairing_start,
};
pub use rollout::{AccountBackend, Rollout};
pub use transport::{canonical_server_url, tls_config};

/// Keychain entry of the connector token.
pub const CONNECTOR_TOKEN: &str = "connector-token";

/// Account-link failures. Messages never carry credentials.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    /// Local state.
    Local(String),
    /// Network or TLS.
    Network(String),
    /// The server refused: HTTP status and its error code.
    Server(u16, String),
    /// HTTP 429, with the server's retry delay when supplied.
    RateLimited(Option<u64>),
    /// The credential was rejected (401/403): sign in again.
    Unauthenticated,
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Local(m) => write!(f, "account state: {m}"),
            CloudError::Network(m) => write!(f, "network: {m}"),
            CloudError::Server(s, c) => write!(f, "server refused ({s} {c})"),
            CloudError::RateLimited(Some(seconds)) => {
                write!(f, "rate limited; retry after {seconds} seconds")
            }
            CloudError::RateLimited(None) => f.write_str("rate limited; try again later"),
            CloudError::Unauthenticated => f.write_str("the account credential was rejected"),
        }
    }
}

impl std::error::Error for CloudError {}

/// An authenticated connector client.
pub struct Cloud {
    http: reqwest::Client,
    /// Server origin.
    pub server: String,
    token: Zeroizing<String>,
    clock_skew: std::sync::atomic::AtomicBool,
}

impl std::fmt::Debug for Cloud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cloud")
            .field("server", &self.server)
            .finish_non_exhaustive()
    }
}

#[path = "cloud_migration_record.rs"]
pub mod migration_record;

#[cfg(test)]
#[path = "cloud_rollout_tests.rs"]
mod rollout_tests;

#[cfg(test)]
#[path = "cloud_retirement_tests.rs"]
mod retirement_tests;
