//! One native-owned read driver and region, shared by ClientApi and host I/O.
use super::*;
use crate::api::Push;
use crate::api::{ApiResult, ErrorCode, SessionId, StreamId, Target};
use crate::file_io::{AttachmentRegion, FileReads, ObjectRead};
use crate::log::{CallId, LogReply, LogRequest, LogResponse};
use mdbn_wire::client::FileView;
use mdbn_wire::common::Hash;

pub(crate) struct ClientFiles {
    reads: FileReads,
    pub(super) region: AttachmentRegion,
    pub(super) upload: Option<super::client_upload_resume::UploadLane>,
    // The exact native LS call and original opaque read ticket, not app input.
    call: Option<(CallId, u64)>,
}

impl<S: Store> Replica<S> {
    // Only synchronous internal operations use this split borrow. No external
    // callback/reentry is allowed while the driver is outside the replica.
    pub(super) fn with_client_files<T>(
        &mut self,
        f: impl FnOnce(&mut Self, &mut ClientFiles) -> T,
    ) -> T {
        let mut io = self.client_files.take().unwrap_or_else(|| ClientFiles {
            reads: FileReads::new(self.now()),
            region: AttachmentRegion::new(),
            upload: None,
            call: None,
        });
        let result = f(self, &mut io);
        self.client_files = Some(io);
        result
    }

    pub(crate) fn client_read_file(
        &mut self,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
    ) -> ApiResult<(StreamId, FileView)> {
        let pin = self.client_file_read_pin(session, target, range, revision)?;
        self.with_client_files(|r, io| {
            if io
                .upload
                .as_ref()
                .is_some_and(super::client_upload_resume::UploadLane::blocks_read)
            {
                return Err(crate::file_io::busy());
            }
            io.reads
                .start_pinned(r, session, pin, range, &mut io.region)
        })
    }
    pub(crate) fn client_ack_chunks(
        &mut self,
        session: SessionId,
        stream: StreamId,
        offset: u64,
    ) -> ApiResult<()> {
        let authority = self.require(session, crate::policy::capability::READ);
        let Some(mut io) = self.client_files.take() else {
            authority?;
            return Err(ErrorCode::NotFound.err("file stream is not active"));
        };
        // Revalidate custody even on an authority refusal, but never reveal the
        // active lane's failure ahead of the caller's own authority check.
        let custody = io.reads.recheck(self, &mut io.region);
        let result = authority
            .and(custody)
            .and_then(|()| io.reads.ack(self, session, stream, offset, &io.region));
        self.client_files = Some(io);
        result
    }
    pub(crate) fn client_cancel_stream(
        &mut self,
        session: SessionId,
        stream: StreamId,
    ) -> ApiResult<()> {
        // Even a now-revoked owner may retire its exact stream; perform cleanup
        // before returning the authority failure, never touching another lane.
        let authority = self.require(session, crate::policy::capability::READ);
        if let Some(io) = self.client_files.as_mut() {
            io.reads.cancel(session, stream, &mut io.region)?;
        }
        self.prune_client_file_call();
        authority
    }
    pub(crate) fn client_files_close(&mut self, session: SessionId) {
        if self.client_files.is_some() {
            self.client_upload_close(session);
        }
        if let Some(io) = self.client_files.as_mut() {
            io.reads.close(session, &mut io.region);
        }
        self.prune_client_file_call();
    }
    /// Session holding the one native read lane.
    pub fn attachment_read_session(&self) -> Option<SessionId> {
        self.client_files.as_ref()?.reads.active_session()
    }
    /// Native read idle deadline, in the injected host clock's milliseconds.
    pub fn attachment_read_deadline(&self) -> Option<i64> {
        self.client_files.as_ref()?.reads.deadline()
    }
    /// Expire the native lane and wipe its lease; the transport closes the result.
    pub fn attachment_read_tick(&mut self, now: i64) -> Option<SessionId> {
        let io = self.client_files.as_mut()?;
        io.reads.tick(now, &mut io.region)
    }
    /// Retire Blob plaintext custody, or reset AttachmentV1 ciphertext input.
    pub fn attachment_read_retire_transport(&mut self) {
        let retired = self
            .client_files
            .as_mut()
            .and_then(|io| io.reads.retire_transport(&mut io.region));
        self.prune_client_file_call();
        if let Some(session) = retired {
            // Do not strand the SDK waiting for a last chunk on a retired lane.
            self.client_file_failed(session);
        }
    }
    /// Trusted host I/O request, not an admission permit or an app-selected address.
    pub fn attachment_read_object(&mut self) -> Result<Option<ObjectRead>, SessionId> {
        let Some(mut io) = self.client_files.take() else {
            return Ok(None);
        };
        let result = io.reads.object(self, &io.region);
        if let Err(session) = result {
            io.reads.close(session, &mut io.region);
        }
        self.client_files = Some(io);
        result
    }
    /// Recheck the original native ticket after every host await.
    pub fn attachment_read_allowed(&self, ticket: u64) -> bool {
        self.client_files
            .as_ref()
            .is_some_and(|io| io.reads.allowed(self, ticket, &io.region))
    }
    /// Reserve only the bounded native-pinned ciphertext object.
    pub fn attachment_read_reserve(&mut self, ticket: u64, size: u64) -> bool {
        let Some(mut io) = self.client_files.take() else {
            return false;
        };
        let result = io.reads.recheck(self, &mut io.region).is_ok()
            && io.reads.reserve(self, ticket, size, &mut io.region);
        self.client_files = Some(io);
        result
    }
    /// Borrow a synchronous bounded input slice; never retain a view across awaits.
    pub fn attachment_read_region(&mut self, ticket: u64, size: usize) -> Option<*mut u8> {
        let mut io = self.client_files.take()?;
        let result = if io.reads.recheck(self, &mut io.region).is_ok() {
            io.reads.region(self, ticket, size, &mut io.region)
        } else {
            None
        };
        self.client_files = Some(io);
        result
    }
    /// Commit exactly the previously minted synchronous input slice.
    pub fn attachment_read_written(&mut self, ticket: u64, size: usize) -> bool {
        let Some(mut io) = self.client_files.take() else {
            return false;
        };
        let result = io.reads.recheck(self, &mut io.region).is_ok()
            && io.reads.written(self, ticket, size, &io.region);
        self.client_files = Some(io);
        result
    }
    /// Append a bounded ciphertext segment through the same region lease.
    pub fn attachment_read_write(&mut self, ticket: u64, bytes: &[u8]) -> bool {
        let Some(mut io) = self.client_files.take() else {
            return false;
        };
        let result = io.reads.recheck(self, &mut io.region).is_ok()
            && io.reads.append(self, ticket, bytes, &mut io.region);
        self.client_files = Some(io);
        result
    }
    /// Authenticate the object in place before any plaintext output.
    pub fn attachment_read_complete(
        &mut self,
        ticket: u64,
        checksum: Hash,
    ) -> Result<bool, SessionId> {
        let Some(mut io) = self.client_files.take() else {
            return Ok(false);
        };
        let result = io.reads.complete(self, ticket, checksum, &mut io.region);
        if let Err(session) = result {
            io.reads.close(session, &mut io.region);
        }
        self.client_files = Some(io);
        result
    }
    /// Fail only this ticket, never a successor's region lease.
    pub fn attachment_read_failed(&mut self, ticket: u64) -> Option<SessionId> {
        let io = self.client_files.as_mut()?;
        io.reads.fail(ticket, &mut io.region)
    }
    /// Emit one bounded frame immediately before synchronous transport admission.
    pub fn attachment_read_poll(&mut self) -> Result<Option<(SessionId, Vec<u8>)>, SessionId> {
        let Some(mut io) = self.client_files.take() else {
            return Ok(None);
        };
        let result = io.reads.poll(self, &mut io.region);
        if let Err(session) = result {
            io.reads.close(session, &mut io.region);
        }
        self.client_files = Some(io);
        result
    }
    // Drop cancelled/retired calls before transport capture or reply decoding.
    pub(crate) fn prune_client_file_call(&mut self) {
        let stale = self
            .client_files
            .as_ref()
            .and_then(|io| io.call)
            .filter(|(_, ticket)| !self.attachment_read_allowed(*ticket));
        if let Some((id, _)) = stale {
            self.client_files
                .as_mut()
                .expect("call belongs to existing I/O")
                .call = None;
            self.inflight.remove(&id);
            self.forget_log_reply_scope(id);
            self.calls.retain(|call| call.id != id);
        }
    }
    fn client_file_failed(&mut self, session: SessionId) {
        let mut problem = ErrorCode::Unavailable.problem_with_reason(
            "file_read_failed",
            "the native file stream could not complete",
        );
        problem.details = self
            .client_files
            .as_mut()
            .and_then(|io| io.reads.take_failure(session));
        crate::api::ClientApi::close(self, session);
        self.pushes.push((session, Push::Closed(problem)));
    }
    /// Drive device reads through the canonical, authenticated LS call path.
    /// Hosted transport already streams R2 segments through the same native lane.
    pub(crate) fn client_file_read_step(&mut self) {
        self.client_upload_prune();
        self.client_upload_resume_step();
        if self.is_hosted() {
            return;
        }
        self.prune_client_file_call();
        let Some(io) = self.client_files.as_ref() else {
            return;
        };
        if let Some((id, _)) = io.call {
            if self.inflight.contains_key(&id) {
                return;
            }
            // Repoint discarded the original call; do not reuse its ticket.
            self.attachment_read_retire_transport();
        }
        match self.attachment_read_object() {
            Ok(Some(object)) => {
                let id = self.queue(LogRequest::GetObject {
                    collection: self.cfg.collection,
                    address: object.address,
                    range: None,
                });
                self.inflight
                    .insert(id, super::append::Inflight::ClientFileRead(object.ticket));
                self.client_files
                    .as_mut()
                    .expect("native object requires I/O")
                    .call = Some((id, object.ticket));
            }
            Ok(None) => {}
            Err(session) => self.client_file_failed(session),
        }
    }
    pub(crate) fn on_client_file_read_reply(&mut self, id: CallId, ticket: u64, reply: LogReply) {
        let Some(io) = self.client_files.as_mut() else {
            return;
        };
        if io.call != Some((id, ticket)) {
            return;
        }
        io.call = None;
        if !self.attachment_read_allowed(ticket) {
            if let Some(session) = self.attachment_read_session() {
                self.client_file_failed(session);
            }
            return;
        }
        let Some(session) = self.attachment_read_session() else {
            return;
        };
        let valid = match reply {
            Ok(LogResponse::GetObject {
                bytes,
                size,
                checksum,
            }) => {
                // Whole replies are one bounded sealed chunk, never a whole file.
                // Wipe the transport copy after authenticating the leased backing.
                let bytes = zeroize::Zeroizing::new(bytes);
                size == bytes.len() as u64
                    && self.attachment_read_reserve(ticket, size)
                    && bytes
                        .chunks(crate::file_io::MAX_OUT_FRAME)
                        .all(|part| self.attachment_read_write(ticket, part))
                    && self
                        .attachment_read_complete(ticket, checksum)
                        .is_ok_and(|done| done)
            }
            _ => false,
        };
        if !valid {
            self.client_file_failed(session);
        }
    }
    /// One typed chunk per device push drain; existing ACK credit bounds output.
    pub(crate) fn client_file_push(&mut self) -> Option<(SessionId, Push)> {
        if self.is_hosted() {
            return None;
        }
        let mut io = self.client_files.take()?;
        let result = io.reads.poll_chunk(self, &mut io.region);
        if let Err(session) = result {
            io.reads.close(session, &mut io.region);
        }
        self.client_files = Some(io);
        match result {
            Ok(chunk) => {
                self.client_file_read_step();
                chunk.map(|(session, chunk)| (session, Push::FileChunk(chunk)))
            }
            Err(session) => {
                self.client_file_failed(session);
                None
            }
        }
    }
    /// Testing-only region inspection, also used to exercise read/upload exclusion.
    #[cfg(any(test, feature = "testing"))]
    pub fn test_attachment_read_region(&mut self) -> &mut AttachmentRegion {
        if self.client_files.is_none() {
            self.client_files = Some(ClientFiles {
                reads: FileReads::new(self.now()),
                region: AttachmentRegion::new(),
                upload: None,
                call: None,
            });
        }
        &mut self
            .client_files
            .as_mut()
            .expect("initialized above")
            .region
    }
}
