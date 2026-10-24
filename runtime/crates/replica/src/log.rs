//! The replica's side of the log service (`docs/contracts/log-service-api.md`).
//!
//! # Shape: sans-I/O, plus a trait for backends
//!
//! The replica never performs network I/O. It queues [`LogCall`]s and is fed
//! [`LogReply`]s and [`LogPush`]es by its host:
//!
//! ```text
//!   replica.take_log_calls() ──► host ──► LogClient::call() (or an async transport)
//!   replica.on_log_reply(id, result) ◄──┘
//!   replica.on_log_push(push)        ◄── subscription / ephemeral pushes
//! ```
//!
//! That one shape serves every host, and every place a log can live: the embedded
//! in-process log service of a local-only collection (logsvc's SQLite backend,
//! bound in process with no network), the hosted log, or a test fake. Hosts route
//! each call by [`LogCall::endpoint`]. It serves a native daemon on a thread, the WASM runtime
//! with JS `fetch`/WebSocket promises, the hosted replica, and the simulator, which
//! delays, drops, duplicates and reorders calls deterministically.
//!
//! [`LogClient`] is the trait the log-service workstream implements for real
//! backends (WebSocket/HTTPS transports, and a direct in-process binding to
//! `mdbn-log-service` for the simulator). Synchronous hosts pump calls through it
//! with [`pump`]. [`crate::fake::FakeLog`] is the in-memory fake for tests.
//!
//! # What the transport owns, and what it doesn't
//!
//! - **The transport owns:** the WebSocket, `hello` and proof of possession (it is
//!   given the device signing key by the host), token refresh on `unauthenticated`,
//!   pre-signed direct transfers for objects over 1 MiB (the replica only sees
//!   bytes), reconnects and re-subscribing.
//! - **The replica owns:** every decision the contract leaves to it: what to append,
//!   retrying the same bytes after [`LogError::NoResponse`], `head_moved` and
//!   `duplicate` handling, uploads before appends, and mapping service errors to
//!   status and client problems (`replica-client-api.md` §9).

use std::fmt;

use mdbn_wire::common::{B16, B32, Hash, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::log_service::{
    AppendParams, AppendResult, EndorseSnapshotParams, HeadResult, PutSnapshotParams, ReadParams,
    ReadResult, SeqItem, SnapshotPointer, StreamEventKind,
};

/// Which log endpoint a call is for, as labelled by the host: the embedded
/// in-process service of a local collection, or a hosted log. Every collection has
/// a log (synced collection contract); only where it lives varies. During a log move (enabling or
/// disabling sync) the replica is repointed from one endpoint to another
/// ([`crate::Replica::repoint_log`]); hosts route each call by its endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EndpointId(pub u64);

/// Correlates a call with its reply. Unique per replica instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CallId(pub u64);

/// A request to the log service, for one collection.
#[derive(Debug, Clone, PartialEq)]
pub enum LogRequest {
    /// Conditional append (§4).
    Append(AppendParams),
    /// Read a range (§5).
    Read(ReadParams),
    /// The head (§5).
    Head {
        /// Collection.
        collection: Uuid,
    },
    /// Subscribe to pushes after `after` (§9). Re-sent by the replica after the
    /// transport reports a reconnect ([`LogPush::Reconnected`]).
    Subscribe {
        /// Collection.
        collection: Uuid,
        /// The replica's applied head.
        after: u64,
        /// Inline items up to this many bytes per push.
        inline_bytes: Option<u64>,
    },
    /// Stop pushes.
    Unsubscribe {
        /// Collection.
        collection: Uuid,
    },
    /// Store an object (§6). The transport picks inline or direct upload and commits.
    PutObject {
        /// Collection.
        collection: Uuid,
        /// Address: `SHA-256(bytes)` for manifests and chunks, keyed for blob parts.
        address: B32,
        /// `manifest`, `chunk` or `blob-part`.
        kind: ItemKind,
        /// The canonical envelope bytes.
        bytes: Vec<u8>,
    },
    /// Fetch an object, or a byte range of it (§6).
    GetObject {
        /// Collection.
        collection: Uuid,
        /// Address.
        address: B32,
        /// `(offset, len)`.
        range: Option<(u64, u64)>,
    },
    /// Which of these objects exist (≤ 1,024).
    HasObjects {
        /// Collection.
        collection: Uuid,
        /// Addresses.
        addresses: Vec<B32>,
    },
    /// Register a snapshot (§7).
    PutSnapshot(PutSnapshotParams),
    /// The retained snapshots.
    GetSnapshot {
        /// Collection.
        collection: Uuid,
    },
    /// Endorse another device's snapshot.
    EndorseSnapshot(EndorseSnapshotParams),
    /// Join an ephemeral stream (§8).
    StreamJoin {
        /// Collection.
        collection: Uuid,
        /// Stream ID.
        stream: B16,
    },
    /// Leave an ephemeral stream.
    StreamLeave {
        /// Collection.
        collection: Uuid,
        /// Stream ID.
        stream: B16,
    },
    /// Send an ephemeral message.
    StreamSend {
        /// Collection.
        collection: Uuid,
        /// Stream ID.
        stream: B16,
        /// Sealed ephemeral envelope.
        message: Vec<u8>,
    },
}

impl LogRequest {
    /// Method name on the wire (`log-service-api.md`).
    pub fn method(&self) -> &'static str {
        match self {
            LogRequest::Append(_) => "append",
            LogRequest::Read(_) => "read",
            LogRequest::Head { .. } => "head",
            LogRequest::Subscribe { .. } => "subscribe",
            LogRequest::Unsubscribe { .. } => "unsubscribe",
            LogRequest::PutObject { .. } => "put_object",
            LogRequest::GetObject { .. } => "get_object",
            LogRequest::HasObjects { .. } => "has_objects",
            LogRequest::PutSnapshot(_) => "put_snapshot",
            LogRequest::GetSnapshot { .. } => "get_snapshot",
            LogRequest::EndorseSnapshot(_) => "endorse_snapshot",
            LogRequest::StreamJoin { .. } => "stream_join",
            LogRequest::StreamLeave { .. } => "stream_leave",
            LogRequest::StreamSend { .. } => "stream_send",
        }
    }
}

/// A successful response. The variant matches the request.
#[derive(Debug, Clone, PartialEq)]
pub enum LogResponse {
    /// `appended`, `head_moved` or `duplicate`.
    Append(AppendResult),
    /// A page of items.
    Read(ReadResult),
    /// The head.
    Head(HeadResult),
    /// Subscribed: the current head and its chain.
    Subscribed {
        /// Head.
        head: u64,
        /// `chain(head)`.
        head_chain: Hash,
    },
    /// The object was stored now, or already existed.
    PutObject {
        /// `true` if it already existed (deduplication).
        existed: bool,
    },
    /// Object bytes (or the requested range).
    GetObject {
        /// Bytes.
        bytes: Vec<u8>,
        /// Whole object size.
        size: u64,
        /// SHA-256 of the whole object.
        checksum: Hash,
    },
    /// One flag per requested address.
    HasObjects(Vec<bool>),
    /// Whether the snapshot was accepted.
    PutSnapshot(bool),
    /// Retained snapshots, newest first.
    GetSnapshot(Vec<SnapshotPointer>),
    /// Whether the endorsement was recorded.
    EndorseSnapshot(bool),
    /// Devices currently joined.
    StreamJoined(Vec<Uuid>),
    /// Sessions the message was queued for.
    StreamSent(u64),
    /// Done (unsubscribe, stream leave).
    Ok,
}

/// Log service error codes (`log-service-api.md` §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogErrorCode {
    /// Missing, expired or unbound token (the transport refreshes and retries first).
    Unauthenticated,
    /// Not allowed: revoked, viewer appending, wrong kind.
    Forbidden,
    /// No such collection or object.
    NotFound,
    /// Deleted or moved.
    Gone,
    /// Malformed request or items.
    Invalid,
    /// Over a size limit.
    TooLarge,
    /// Referenced objects are absent.
    RefsMissing,
    /// Frozen or rekey-required.
    Frozen,
    /// Over a rate limit.
    RateLimited,
    /// Over the storage quota.
    QuotaExceeded,
    /// Restarting, moving or overloaded.
    Unavailable,
    /// API version no longer supported.
    UpgradeRequired,
}

impl LogErrorCode {
    /// The code as on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            LogErrorCode::Unauthenticated => "unauthenticated",
            LogErrorCode::Forbidden => "forbidden",
            LogErrorCode::NotFound => "not_found",
            LogErrorCode::Gone => "gone",
            LogErrorCode::Invalid => "invalid",
            LogErrorCode::TooLarge => "too_large",
            LogErrorCode::RefsMissing => "refs_missing",
            LogErrorCode::Frozen => "frozen",
            LogErrorCode::RateLimited => "rate_limited",
            LogErrorCode::QuotaExceeded => "quota_exceeded",
            LogErrorCode::Unavailable => "unavailable",
            LogErrorCode::UpgradeRequired => "upgrade_required",
        }
    }

    /// Parse a wire code. Unknown codes are `None`; transports map them to
    /// [`LogErrorCode::Unavailable`] after logging.
    pub fn parse(s: &str) -> Option<LogErrorCode> {
        use LogErrorCode::*;
        [
            Unauthenticated,
            Forbidden,
            NotFound,
            Gone,
            Invalid,
            TooLarge,
            RefsMissing,
            Frozen,
            RateLimited,
            QuotaExceeded,
            Unavailable,
            UpgradeRequired,
        ]
        .into_iter()
        .find(|c| c.as_str() == s)
    }
}

/// A failed call.
#[derive(Debug, Clone, PartialEq)]
pub enum LogError {
    /// The service answered with an error. Nothing was changed by the request.
    Service {
        /// Code.
        code: LogErrorCode,
        /// Finer reason (`chain`, `signature`, ...).
        reason: Option<String>,
        /// Retry hint.
        retry_after_ms: Option<u64>,
        /// Missing addresses, for `refs_missing`.
        missing: Vec<B32>,
    },
    /// No response: timeout or lost connection. **The outcome is unknown**; for an
    /// append the replica retries the same bytes (`log-entry.md` §3.1 step 5).
    NoResponse,
    /// No route to the service right now (offline). Nothing was sent.
    Offline,
}

impl LogError {
    /// A service error with just a code.
    pub fn code(code: LogErrorCode) -> LogError {
        LogError::Service {
            code,
            reason: None,
            retry_after_ms: None,
            missing: Vec::new(),
        }
    }
}

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogError::Service { code, reason, .. } => match reason {
                Some(r) => write!(f, "{} ({r})", code.as_str()),
                None => write!(f, "{}", code.as_str()),
            },
            LogError::NoResponse => write!(f, "no response"),
            LogError::Offline => write!(f, "offline"),
        }
    }
}

impl std::error::Error for LogError {}

/// A call queued by the replica.
#[derive(Debug, Clone, PartialEq)]
pub struct LogCall {
    /// Correlation ID.
    pub id: CallId,
    /// The endpoint to send it to.
    pub endpoint: EndpointId,
    /// The request.
    pub request: LogRequest,
}

/// The reply to a call.
pub type LogReply = Result<LogResponse, LogError>;

/// An unsolicited message from the service, or a transport event.
#[derive(Debug, Clone, PartialEq)]
pub enum LogPush {
    /// The head advanced; read what is missing.
    Head {
        /// Collection.
        collection: Uuid,
        /// Head.
        head: u64,
        /// `chain(head)`.
        head_chain: Hash,
    },
    /// New items inline.
    Items {
        /// Collection.
        collection: Uuid,
        /// Items in order.
        items: Vec<SeqItem>,
        /// Head.
        head: u64,
        /// `chain(head)`.
        head_chain: Hash,
    },
    /// The subscription was dropped (revocation, deletion, move); reason is a code.
    Closed {
        /// Collection.
        collection: Uuid,
        /// Error code.
        reason: String,
    },
    /// An ephemeral message.
    StreamMsg {
        /// Collection.
        collection: Uuid,
        /// Stream.
        stream: B16,
        /// Sending device.
        from: Uuid,
        /// Sealed message.
        message: Vec<u8>,
    },
    /// A device joined or left a stream.
    StreamEvent {
        /// Collection.
        collection: Uuid,
        /// Stream.
        stream: B16,
        /// Device.
        device: Uuid,
        /// Joined or left.
        event: StreamEventKind,
    },
    /// Transport event: the connection is up again. The replica re-subscribes and
    /// re-reads the head. Every call in flight across the outage has been, or will
    /// be, answered with [`LogError::NoResponse`].
    Reconnected,
    /// Transport event: the connection is down; calls now fail with
    /// [`LogError::Offline`] until [`LogPush::Reconnected`].
    Disconnected,
}

/// A log-service backend, as a synchronous request/response client.
///
/// Implemented by the log-service workstream (network transports; an in-process
/// binding for the simulator) and by [`crate::fake::FakeLog`]. Async hosts don't
/// need this trait: they take [`LogCall`]s from the replica and feed replies back
/// themselves.
pub trait LogClient {
    /// Perform one request. Must not panic on any input.
    fn call(&mut self, request: LogRequest) -> LogReply;
    /// Pushes received since the last poll, in arrival order.
    fn poll_pushes(&mut self) -> Vec<LogPush>;
}

/// The replica's sans-I/O log port: what [`pump`] drives.
pub trait LogPort {
    /// Calls queued since the last take, in order.
    fn take_log_calls(&mut self) -> Vec<LogCall>;
    /// Deliver a reply.
    fn on_log_reply(&mut self, id: CallId, reply: LogReply);
    /// Deliver a push.
    fn on_log_push(&mut self, push: LogPush);
}

/// Drive a port against a synchronous client until neither has anything left to
/// deliver, or `max_rounds` rounds have run. Returns the number of calls made.
pub fn pump(port: &mut dyn LogPort, client: &mut dyn LogClient, max_rounds: u32) -> u64 {
    let mut calls = 0u64;
    for _ in 0..max_rounds {
        let mut progressed = false;
        for push in client.poll_pushes() {
            progressed = true;
            port.on_log_push(push);
        }
        for call in port.take_log_calls() {
            progressed = true;
            calls += 1;
            let reply = client.call(call.request);
            port.on_log_reply(call.id, reply);
        }
        if !progressed {
            break;
        }
    }
    calls
}
