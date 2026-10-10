//! # mdbn-local-host: the native composition of a collection folder
//!
//! **Responsibility.** One place where a native process turns a folder into a
//! replica: the file store over the native platform and SQLite index
//! ([`open_store`]), the folder host lock ([`host_lock`]), a persisted replica
//! identity ([`identity`]), the host services a replica needs natively
//! ([`host`]: wall clock, OS entropy, IANA zones), and the local-only drive loop
//! ([`LocalReplica`]). The `mdbase` crate (and through it the Node package) and
//! the daemon's collection runtime both build on it, so the local stack is
//! composed once rather than independently by each consumer.
//!
//! Nothing here decides semantics or policy: grants come from the caller's
//! [`mdbn_replica::policy::GrantSource`], the editor fence is the caller's, and
//! the daemon wraps the store in its own middleware before opening a replica.
//!
//! **Rules.** Native only; real I/O lives here, so it opts out of the
//! portability lints. Never linked into WASM.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`,
//! `mdbn-replica`, `mdbn-store-file`, `mdbn-platform-native`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

pub mod host;
pub mod host_lock;
pub mod identity;
pub mod replica;
pub mod store;

pub use host::{OsEntropy, SystemClock, SystemZones};
pub use host_lock::{Descriptor, DescriptorState, HostKind, HostLock, LockError};
pub use identity::Identity;
pub use replica::{LocalReplica, NativeReplica, ReplicaOptions};
pub use store::{NativeStore, StoreOptions, open_store};

/// What can go wrong composing a folder.
#[derive(Debug)]
pub enum Error {
    /// The folder is hosted by someone else, or its private dir is unsafe.
    Lock(LockError),
    /// The platform could not open the folder.
    Platform(mdbn_store_file::platform::FsError),
    /// The SQLite index could not be opened.
    Index(mdbn_store_file::index::IndexError),
    /// The store could not be opened.
    Store(mdbn_replica::StoreError),
    /// The replica could not be opened.
    Replica(mdbn_replica::replica::OpenError),
    /// The identity file is unreadable or inconsistent with the store.
    Identity(String),
    /// Plain I/O.
    Io(std::io::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Lock(e) => write!(f, "{e}"),
            Error::Platform(e) => write!(f, "file platform: {e:?}"),
            Error::Index(e) => write!(f, "index: {e:?}"),
            Error::Store(e) => write!(f, "store: {e:?}"),
            Error::Replica(e) => write!(f, "replica: {e:?}"),
            Error::Identity(s) => write!(f, "identity: {s}"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<LockError> for Error {
    fn from(e: LockError) -> Self {
        Error::Lock(e)
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
impl From<mdbn_replica::StoreError> for Error {
    fn from(e: mdbn_replica::StoreError) -> Self {
        Error::Store(e)
    }
}
impl From<mdbn_replica::replica::OpenError> for Error {
    fn from(e: mdbn_replica::replica::OpenError) -> Self {
        Error::Replica(e)
    }
}
