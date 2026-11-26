//! Bounded deferral of requests whose replica work is still outstanding, using
//! original RPC IDs: native upload input/capture, and history log reads
//! (`replica-client-api.md` §4.4). Each poll asks the replica again; a pending
//! answer is never sent to the client.
use super::*;
use mdbn_wire::client::{RecordHistoryParams, RecordVersionParams};
use zeroize::Zeroize;

// The SDK sends four concurrent fragments. One native file lane may retain at
// most that many 1MiB request bodies, independent of session/request count.
const MAX_FILE_HOLDS: usize = 4;
const MAX_FRAGMENT_BYTES: usize = 1 << 20;
// History params are small; the replica bounds its own concurrent reads.
const MAX_HISTORY_HOLDS: usize = 8;

pub(super) enum Call {
    Open(OpenUploadParams),
    Chunk(UploadChunkParams),
    Commit(Uuid),
    History(RecordHistoryParams),
    Version(RecordVersionParams),
}
impl std::fmt::Debug for Call {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(_) => f.write_str("Open"),
            Self::Chunk(p) => f
                .debug_struct("Chunk")
                .field("index", &p.index)
                .field("bytes_len", &p.bytes.0.len())
                .finish(),
            Self::Commit(_) => f.write_str("Commit"),
            Self::History(_) => f.write_str("History"),
            Self::Version(_) => f.write_str("Version"),
        }
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        if let Self::Chunk(p) = self {
            p.bytes.0.zeroize();
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lane {
    File,
    History,
}
impl Lane {
    fn pending_reason(self) -> &'static str {
        match self {
            Lane::File => "file_upload_pending",
            Lane::History => crate::api::HISTORY_LOADING,
        }
    }
    fn bound(self) -> usize {
        match self {
            Lane::File => MAX_FILE_HOLDS,
            Lane::History => MAX_HISTORY_HOLDS,
        }
    }
    fn full(self) -> ApiError {
        match self {
            Lane::File => ErrorCode::Unavailable.err_with_reason(
                "file_upload_backpressure",
                "the bounded file RPC window is full",
            ),
            Lane::History => ErrorCode::Unavailable
                .err_with_reason("history_backpressure", "too many history reads are waiting"),
        }
    }
    fn deadline(self) -> ApiError {
        match self {
            Lane::File => ErrorCode::Unavailable.err_with_reason(
                "file_upload_outcome_unknown",
                "file RPC deadline elapsed while native work was pending",
            ),
            Lane::History => ErrorCode::Unavailable.err_with_reason(
                "history_timeout",
                "history log reads did not finish in time",
            ),
        }
    }
}
impl Call {
    fn lane(&self) -> Lane {
        match self {
            Self::Open(_) | Self::Chunk(_) | Self::Commit(_) => Lane::File,
            Self::History(_) | Self::Version(_) => Lane::History,
        }
    }
    fn poll(&self, api: &mut dyn ClientApi, session: SessionId) -> ApiResult<Cbor> {
        match self {
            Self::Open(p) => api.open_upload(session, p.clone()).map(|r| r.to_cbor()),
            Self::Chunk(p) => api.upload_chunk(session, p.clone()).map(Cbor::Uint),
            Self::Commit(transfer) => api.commit_upload(session, *transfer).map(|r| r.to_cbor()),
            Self::History(p) => api.record_history(session, p.clone()).map(|r| r.to_cbor()),
            Self::Version(p) => api.record_version(session, p.clone()).map(|r| r.to_cbor()),
        }
    }
    fn pending(&self, result: &ApiResult<Cbor>) -> bool {
        result.as_ref().err().is_some_and(|e| {
            e.problem().code == "unavailable"
                && e.problem().reason.as_deref() == Some(self.lane().pending_reason())
        })
    }
}
#[derive(Debug)]
pub(super) struct Deferred {
    session: SessionId,
    request: u64,
    call: Call,
    started: Option<i64>,
}
impl Frames {
    pub(super) fn defer(
        &mut self,
        api: &mut dyn ClientApi,
        session: SessionId,
        request: u64,
        call: Call,
    ) {
        if matches!(&call, Call::Chunk(p) if p.bytes.0.len() > MAX_FRAGMENT_BYTES) {
            self.respond(
                session,
                request,
                Err(ErrorCode::TooLarge.err("file fragment exceeds the bounded RPC window")),
            );
            return;
        }
        if let Some(index) = self
            .deferred
            .iter()
            .position(|h| h.session == session && h.request == request)
        {
            self.deferred.remove(index);
            self.respond(
                session,
                request,
                Err(ErrorCode::InvalidRequest.err("request ID is already pending")),
            );
            return;
        }
        let result = call.poll(api, session);
        if !call.pending(&result) {
            self.respond(session, request, result);
            return;
        }
        let lane = call.lane();
        if self
            .deferred
            .iter()
            .filter(|h| h.call.lane() == lane)
            .count()
            == lane.bound()
        {
            self.respond(session, request, Err(lane.full()));
            return;
        }
        self.deferred.push(Deferred {
            session,
            request,
            call,
            started: self.ticked.then_some(self.now_ms),
        });
    }
    pub(super) fn deferred_pump(&mut self, api: &mut dyn ClientApi) {
        for mut held in std::mem::take(&mut self.deferred) {
            if !self.sessions.contains_key(&held.session) {
                continue;
            }
            let result = held.call.poll(api, held.session);
            // A real terminal result wins over the timeout. Pending never
            // becomes a fabricated receipt, including at the deadline.
            if !held.call.pending(&result) {
                self.respond(held.session, held.request, result);
                continue;
            }
            if self.ticked {
                let started = *held.started.get_or_insert(self.now_ms);
                if started.saturating_add(MAX_HOLD_MS) <= self.now_ms {
                    self.respond(held.session, held.request, Err(held.call.lane().deadline()));
                    continue;
                }
            }
            self.deferred.push(held);
        }
    }
    pub(super) fn deferred_close(&mut self, session: SessionId) {
        self.deferred.retain(|h| h.session != session);
    }
    pub(super) fn deferred_cancel(&mut self, session: SessionId, request: u64) {
        if let Some(index) = self
            .deferred
            .iter()
            .position(|h| h.session == session && h.request == request)
        {
            self.deferred.remove(index);
            self.respond(
                session,
                request,
                Err(ErrorCode::Cancelled.err("cancelled by the client")),
            );
        }
    }
}
