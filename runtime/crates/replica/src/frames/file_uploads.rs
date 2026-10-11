//! Bounded deferral of native upload input/capture, using original RPC IDs.
use super::*;
use zeroize::Zeroize;

// The SDK sends four concurrent fragments. One native file lane may retain at
// most that many 1MiB request bodies, independent of session/request count.
const MAX_FILE_HOLDS: usize = 4;
const MAX_FRAGMENT_BYTES: usize = 1 << 20;

pub(super) enum FileCall {
    Open(OpenUploadParams),
    Chunk(UploadChunkParams),
    Commit(Uuid),
}
impl std::fmt::Debug for FileCall {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(_) => f.write_str("Open"),
            Self::Chunk(p) => f
                .debug_struct("Chunk")
                .field("index", &p.index)
                .field("bytes_len", &p.bytes.0.len())
                .finish(),
            Self::Commit(_) => f.write_str("Commit"),
        }
    }
}
impl Drop for FileCall {
    fn drop(&mut self) {
        if let Self::Chunk(p) = self {
            p.bytes.0.zeroize();
        }
    }
}
impl FileCall {
    fn poll(&self, api: &mut dyn ClientApi, session: SessionId) -> ApiResult<Cbor> {
        match self {
            Self::Open(p) => api.open_upload(session, p.clone()).map(|r| r.to_cbor()),
            Self::Chunk(p) => api.upload_chunk(session, p.clone()).map(Cbor::Uint),
            Self::Commit(transfer) => api.commit_upload(session, *transfer).map(|r| r.to_cbor()),
        }
    }
}
#[derive(Debug)]
pub(super) struct HeldFile {
    session: SessionId,
    request: u64,
    call: FileCall,
    started: Option<i64>,
}
fn pending(result: &ApiResult<Cbor>) -> bool {
    result.as_ref().err().is_some_and(|e| {
        e.problem().code == "unavailable"
            && e.problem().reason.as_deref() == Some("file_upload_pending")
    })
}
impl Frames {
    pub(super) fn file_request(
        &mut self,
        api: &mut dyn ClientApi,
        session: SessionId,
        request: u64,
        call: FileCall,
    ) {
        if matches!(&call, FileCall::Chunk(p) if p.bytes.0.len() > MAX_FRAGMENT_BYTES) {
            self.respond(
                session,
                request,
                Err(ErrorCode::TooLarge.err("file fragment exceeds the bounded RPC window")),
            );
            return;
        }
        if let Some(index) = self
            .file_holds
            .iter()
            .position(|h| h.session == session && h.request == request)
        {
            self.file_holds.remove(index);
            self.respond(
                session,
                request,
                Err(ErrorCode::InvalidRequest.err("file request ID is already pending")),
            );
            return;
        }
        let result = call.poll(api, session);
        if !pending(&result) {
            self.respond(session, request, result);
            return;
        }
        if self.file_holds.len() == MAX_FILE_HOLDS {
            self.respond(
                session,
                request,
                Err(ErrorCode::Unavailable.err_with_reason(
                    "file_upload_backpressure",
                    "the bounded file RPC window is full",
                )),
            );
            return;
        }
        self.file_holds.push(HeldFile {
            session,
            request,
            call,
            started: self.ticked.then_some(self.now_ms),
        });
    }
    pub(super) fn file_pump(&mut self, api: &mut dyn ClientApi) {
        for mut held in std::mem::take(&mut self.file_holds) {
            if !self.sessions.contains_key(&held.session) {
                continue;
            }
            let result = held.call.poll(api, held.session);
            // A real terminal result wins over the timeout. Pending never
            // becomes a fabricated receipt, including at the deadline.
            if !pending(&result) {
                self.respond(held.session, held.request, result);
                continue;
            }
            if self.ticked {
                let started = *held.started.get_or_insert(self.now_ms);
                if started.saturating_add(MAX_HOLD_MS) <= self.now_ms {
                    self.respond(
                        held.session,
                        held.request,
                        Err(ErrorCode::Unavailable.err_with_reason(
                            "file_upload_outcome_unknown",
                            "file RPC deadline elapsed while native work was pending",
                        )),
                    );
                    continue;
                }
            }
            self.file_holds.push(held);
        }
    }
    pub(super) fn file_close(&mut self, session: SessionId) {
        self.file_holds.retain(|h| h.session != session);
    }
    pub(super) fn file_cancel(&mut self, session: SessionId, request: u64) {
        if let Some(index) = self
            .file_holds
            .iter()
            .position(|h| h.session == session && h.request == request)
        {
            self.file_holds.remove(index);
            self.respond(
                session,
                request,
                Err(ErrorCode::Cancelled.err("cancelled by the client")),
            );
        }
    }
}
