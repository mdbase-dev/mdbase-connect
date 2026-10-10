//! The system under test: the real replica engine, its stores and the log
//! service, wired into the simulated world.
//!
//! | Module | What |
//! |---|---|
//! | [`node`] | a device: `Replica<FileStore<SimFilePlatform, MemStore, MemDiskDb>>` on a machine, its log transport, an in-process client generating work, crash/restart |
//! | [`logsvc`] | the existing FakeLogService network driver for legacy replica scenarios, behind the untrusted-party tap |
//! | [`real_log`] | production memory service, session and hub binding; connections start unauthenticated |
//! | [`real_log_net`] | exact production frames over the simulated network, with caller-owned hello proofs; not yet wired to Replica nodes |
//! | [`real_node`] | the trusted side of that transport for a [`node`]: caller-owned hello, held/sent call phases, exact-frame replies and pushes |
//! | [`planner`] | model semantics until core planning lands |
//!
//! The log transport is an in-process binding: the replica's typed `LogCall`s
//! cross the simulated network as [`crate::world::Payload`]s, next to the
//! canonical bytes of their parameters, which is what the tap scans. Losing a
//! message resets the connection: in-flight calls get `NoResponse`, the replica
//! sees `Disconnected`, then `Reconnected` and re-subscribes.

pub mod fault_store;
pub mod logsvc;
pub mod node;
pub mod planner;
pub mod real_log;
pub mod real_log_net;
pub mod real_node;

use mdbn_replica::log::{LogPush, LogReply, LogRequest};
use mdbn_wire::common::Uuid;
use mdbn_wire::schema::Wire;

/// A log call on the wire.
#[derive(Debug, Clone)]
pub struct LogReq {
    /// The calling device.
    pub device: Uuid,
    /// The replica's call ID.
    pub call: u64,
    /// The request.
    pub req: LogRequest,
}

/// A reply on the wire.
#[derive(Debug, Clone)]
pub struct LogRep {
    /// The call it answers.
    pub call: u64,
    /// The reply.
    pub reply: LogReply,
}

/// A push on the wire.
#[derive(Debug, Clone)]
pub struct LogPushMsg(pub LogPush);

/// The bytes the log service receives for `req` (what the tap scans): the
/// canonical encoding of the request parameters and any opaque payloads.
pub fn wire_bytes(req: &LogRequest) -> Vec<u8> {
    let mut b = req.method().as_bytes().to_vec();
    match req {
        LogRequest::Append(p) => b.extend(p.to_bytes().unwrap_or_default()),
        LogRequest::Read(p) => b.extend(p.to_bytes().unwrap_or_default()),
        LogRequest::PutSnapshot(p) => b.extend(p.to_bytes().unwrap_or_default()),
        LogRequest::EndorseSnapshot(p) => b.extend(p.to_bytes().unwrap_or_default()),
        LogRequest::PutObject { bytes, address, .. } => {
            b.extend_from_slice(&address.0);
            b.extend_from_slice(bytes);
        }
        LogRequest::StreamSend {
            message, stream, ..
        } => {
            b.extend_from_slice(&stream.0);
            b.extend_from_slice(message);
        }
        LogRequest::StreamJoin { stream, .. } | LogRequest::StreamLeave { stream, .. } => {
            b.extend_from_slice(&stream.0);
        }
        LogRequest::HasObjects { addresses, .. } => {
            for a in addresses {
                b.extend_from_slice(&a.0);
            }
        }
        LogRequest::GetObject { address, .. } => b.extend_from_slice(&address.0),
        LogRequest::Head { .. }
        | LogRequest::Subscribe { .. }
        | LogRequest::Unsubscribe { .. }
        | LogRequest::GetSnapshot { .. } => {}
    }
    b
}
