//! One ephemeral authenticated attachment stream per host. No file-sized buffers,
//! no plaintext in SQL: move one verified chunk and drain one app frame per poll.
use super::attachment_region::{AttachmentRegion, RegionLease, RegionOwner};
use crate::api::{ApiResult, ErrorCode, SessionId, StreamId, Target};
use crate::attachments::{AuthenticatedReadSpan, MAX_SEALED_CHUNK, MAX_SEALED_MANIFEST, Need};
use crate::frames::file_chunk_push_slice;
use crate::replica::AttachmentRead;
use crate::{Replica, Store};
use mdbn_wire::client::{FileChunk, FileView};
use mdbn_wire::common::Hash;

/// Existing ciphertext-input slice and encoded app-frame cap (one MiB).
pub const MAX_OUT_FRAME: usize = 1 << 20;
const FRAME_BYTES: usize = MAX_OUT_FRAME - 128;
const WINDOW: u64 = 8 << 20;
const MAX_ID: u64 = (1 << 53) - 1;
const IDLE_MS: i64 = 60_000;

/// One native-pinned ciphertext object request, not a transport admission permit.
#[derive(Debug)]
pub struct ObjectRead {
    /// Native-minted transport ticket.
    pub ticket: u64,
    /// Original authenticated stream session.
    pub session: SessionId,
    /// Exact object address from the pinned descriptor/verified manifest.
    pub address: Hash,
    /// Exact sealed chunk length, or a bounded manifest length checked at reserve.
    pub expected_bytes: Option<u64>,
}

struct CipherInput {
    length: usize,
    filled: usize,
    pending: Option<usize>,
}
struct Fetching {
    ticket: u64,
    need: Need,
    input: Option<CipherInput>,
}
struct Reading {
    id: StreamId,
    session: SessionId,
    pin: AttachmentRead,
    lease: RegionLease,
    held: Option<AuthenticatedReadSpan>,
    cursor: usize,
    sent: u64,
    acked: u64,
    fetching: Option<Fetching>,
    progress_ms: i64,
}

/// Read/ACK/cancel boundary around native pins and one leased attachment region.
/// Transport hosts still enforce live admission before I/O and plaintext output.
pub struct FileReads {
    active: Option<Reading>,
    // One failed completion, consumed by the matching device close. Only typed
    // code/reason are retained: never plaintext, paths or provider messages.
    failure: Option<(SessionId, mdbn_wire::common::Value)>,
    next_stream: u64,
    next_ticket: u64,
    now_ms: i64,
}
fn bad(message: &'static str) -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err(message)
}
/// Existing typed region-capacity refusal; this is not an authority decision.
pub fn busy() -> crate::api::ApiError {
    let mut error = ErrorCode::Unavailable
        .err_with_reason("hosted_chunk_busy", "hosted attachment region is busy");
    error.0.details = Some(mdbn_wire::common::Value::Map(vec![(
        "retry_after_ms".into(),
        mdbn_wire::common::Value::Int(1000),
    )]));
    error
}

impl FileReads {
    /// Initialize the existing monotonic activity clock and opaque ID counters.
    pub fn new(now_ms: i64) -> Self {
        Self {
            active: None,
            failure: None,
            next_stream: 1,
            next_ticket: 1,
            now_ms,
        }
    }
    /// Session owning the current stream, if any.
    pub fn active_session(&self) -> Option<SessionId> {
        self.active.as_ref().map(|a| a.session)
    }
    pub(crate) fn take_failure(&mut self, session: SessionId) -> Option<mdbn_wire::common::Value> {
        if self.failure.as_ref()?.0 != session {
            return None;
        }
        self.failure.take().map(|(_, detail)| detail)
    }
    /// Idle deadline for the active stream.
    pub fn deadline(&self) -> Option<i64> {
        self.active
            .as_ref()
            .map(|a| a.progress_ms.saturating_add(IDLE_MS))
    }
    /// Expire an idle stream, releasing and wiping its exact region lease.
    pub fn tick(&mut self, now_ms: i64, region: &mut AttachmentRegion) -> Option<SessionId> {
        self.now_ms = self.now_ms.max(now_ms);
        if self.deadline().is_some_and(|t| t <= self.now_ms) {
            let a = self.active.take()?;
            region.release(a.lease);
            return Some(a.session);
        }
        None
    }
    /// Pin a confirmed revision after native READ/folder/range/health checks.
    pub fn start<S: Store>(
        &mut self,
        r: &mut Replica<S>,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
        region: &mut AttachmentRegion,
    ) -> ApiResult<(StreamId, FileView)> {
        // Admission precedes capacity reporting and pin creation uses confirmed metadata.
        let pin = r.attachment_read(session, target, range, revision)?;
        self.start_pinned(r, session, pin, range, region)
    }
    /// Split native pin capture from region allocation; used by Replica ownership.
    pub(crate) fn start_pinned<S: Store>(
        &mut self,
        r: &Replica<S>,
        session: SessionId,
        pin: AttachmentRead,
        range: Option<(u64, u64)>,
        region: &mut AttachmentRegion,
    ) -> ApiResult<(StreamId, FileView)> {
        r.attachment_read_check(&pin)?;
        if self.next_stream > MAX_ID {
            return Err(
                ErrorCode::TooLarge.err_with_reason("hosted_read_budget", "stream IDs exhausted")
            );
        }
        if self.active.is_some() {
            return Err(busy());
        }
        let id = StreamId(self.next_stream);
        let lease = region
            .acquire(RegionOwner::Read {
                session,
                stream: id,
            })
            .ok_or_else(busy)?;
        self.next_stream += 1;
        let start = range.map_or(0, |x| x.0);
        let view = pin.view().clone();
        self.failure = None;
        self.active = Some(Reading {
            id,
            session,
            pin,
            lease,
            held: None,
            cursor: 0,
            sent: start,
            acked: start,
            fetching: None,
            progress_ms: self.now_ms,
        });
        Ok((id, view))
    }
    /// Advance this session's ACK within bytes actually emitted for its stream.
    pub fn ack<S: Store>(
        &mut self,
        r: &Replica<S>,
        session: SessionId,
        id: StreamId,
        offset: u64,
        region: &AttachmentRegion,
    ) -> ApiResult<()> {
        let a = self
            .active
            .as_mut()
            .filter(|a| a.session == session && a.id == id)
            .ok_or_else(|| ErrorCode::NotFound.err("file stream is not active"))?;
        r.attachment_read_check(&a.pin)?;
        if !region.owns(a.lease) {
            return Err(ErrorCode::NotFound.err("file stream no longer owns its region"));
        }
        if offset < a.acked || offset > a.sent {
            return Err(bad("ack offset is outside emitted bytes"));
        }
        if offset > a.acked {
            a.progress_ms = self.now_ms;
        }
        a.acked = offset;
        Ok(())
    }
    /// Idempotently cancel only the named session's matching stream.
    pub fn cancel(
        &mut self,
        session: SessionId,
        id: StreamId,
        region: &mut AttachmentRegion,
    ) -> ApiResult<()> {
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.session == session && a.id == id)
            && let Some(a) = self.active.take()
        {
            region.release(a.lease);
        }
        // Idempotent cancellation exposes no other session's stream.
        Ok(())
    }
    /// Release a closing session's stream; a successor's lease is untouched.
    pub fn close(&mut self, session: SessionId, region: &mut AttachmentRegion) {
        if self.active.as_ref().is_some_and(|a| a.session == session)
            && let Some(a) = self.active.take()
        {
            region.release(a.lease);
        }
    }
    /// Drop an outstanding object ticket and scrub its input on transport retirement.
    pub fn retire_transport(&mut self, region: &mut AttachmentRegion) {
        if let Some(a) = self.active.as_mut()
            && a.fetching.take().is_some()
        {
            region.scrub(a.lease);
        }
    }
    /// Request one exact native ciphertext object when the ACK window allows it.
    pub fn object<S: Store>(
        &mut self,
        r: &Replica<S>,
        region: &AttachmentRegion,
    ) -> Result<Option<ObjectRead>, SessionId> {
        let Some(a) = self.active.as_mut() else {
            return Ok(None);
        };
        r.attachment_read_check(&a.pin).map_err(|_| a.session)?;
        if !region.owns(a.lease) {
            return Err(a.session);
        }
        if a.held.is_some() || a.fetching.is_some() || a.sent - a.acked >= WINDOW {
            return Ok(None);
        }
        let Some(need) = a.pin.need() else {
            return Ok(None);
        };
        if self.next_ticket > MAX_ID {
            return Err(a.session);
        }
        let ticket = self.next_ticket;
        self.next_ticket += 1;
        let (address, expected_bytes) = match need {
            Need::Manifest { address } => (address, None),
            Need::Chunk {
                address,
                sealed_bytes,
                ..
            } => (address, Some(sealed_bytes)),
        };
        a.fetching = Some(Fetching {
            ticket,
            need,
            input: None,
        });
        Ok(Some(ObjectRead {
            ticket,
            session: a.session,
            address,
            expected_bytes,
        }))
    }
    /// Recheck the ticket, exact region lease and current native read authority.
    pub fn allowed<S: Store>(
        &self,
        r: &Replica<S>,
        ticket: u64,
        region: &AttachmentRegion,
    ) -> bool {
        self.active.as_ref().is_some_and(|a| {
            region.owns(a.lease)
                && a.fetching.as_ref().is_some_and(|f| f.ticket == ticket)
                && r.attachment_read_check(&a.pin).is_ok()
        })
    }
    /// Fail only the current ticket's stream, wiping and releasing its backing.
    pub fn fail(&mut self, ticket: u64, region: &mut AttachmentRegion) -> Option<SessionId> {
        let session = self
            .active
            .as_ref()
            .filter(|a| a.fetching.as_ref().is_some_and(|f| f.ticket == ticket))
            .map(|a| a.session);
        if session.is_some()
            && let Some(a) = self.active.take()
        {
            region.release(a.lease);
        }
        session
    }
    /// Reserve bounded input for the expected native object, under its exact lease.
    pub fn reserve<S: Store>(
        &mut self,
        r: &Replica<S>,
        ticket: u64,
        size: u64,
        region: &mut AttachmentRegion,
    ) -> bool {
        let Some(a) = self.active.as_mut() else {
            return false;
        };
        if !region.owns(a.lease) || r.attachment_read_check(&a.pin).is_err() {
            return false;
        }
        let Some(f) = a
            .fetching
            .as_mut()
            .filter(|f| f.ticket == ticket && f.input.is_none())
        else {
            return false;
        };
        let valid = match f.need {
            Need::Manifest { .. } => size <= MAX_SEALED_MANIFEST,
            Need::Chunk { sealed_bytes, .. } => size == sealed_bytes && size <= MAX_SEALED_CHUNK,
        };
        if !valid {
            return false;
        }
        let Ok(size) = usize::try_from(size) else {
            return false;
        };
        let Some(bytes) = region.borrow(a.lease) else {
            return false;
        };
        if size > bytes.len() {
            return false;
        }
        region.scrub(a.lease);
        f.input = Some(CipherInput {
            length: size,
            filled: 0,
            pending: None,
        });
        true
    }
    /// Mint only the next bounded slice of the stable private region. The host
    /// reacquires its WASM view after awaits and commits this exact length once.
    pub fn region<S: Store>(
        &mut self,
        r: &Replica<S>,
        ticket: u64,
        count: usize,
        region: &mut AttachmentRegion,
    ) -> Option<*mut u8> {
        let a = self.active.as_mut()?;
        r.attachment_read_check(&a.pin).ok()?;
        let input = a
            .fetching
            .as_mut()
            .filter(|f| f.ticket == ticket)?
            .input
            .as_mut()?;
        let end = input.filled.checked_add(count)?;
        if count > MAX_OUT_FRAME || end > input.length || input.pending.is_some() {
            return None;
        }
        let bytes = region.borrow(a.lease)?;
        input.pending = Some(count);
        Some(bytes[input.filled..end].as_mut_ptr())
    }
    /// Commit only the exact previously lent input slice after rechecking authority.
    pub fn written<S: Store>(
        &mut self,
        r: &Replica<S>,
        ticket: u64,
        count: usize,
        region: &AttachmentRegion,
    ) -> bool {
        let Some(a) = self.active.as_mut() else {
            return false;
        };
        if !region.owns(a.lease) || r.attachment_read_check(&a.pin).is_err() {
            return false;
        }
        let Some(input) = a
            .fetching
            .as_mut()
            .filter(|f| f.ticket == ticket)
            .and_then(|f| f.input.as_mut())
        else {
            return false;
        };
        if input.pending != Some(count) {
            return false;
        }
        input.pending = None;
        input.filled += count;
        if count > 0 {
            a.progress_ms = self.now_ms;
        }
        true
    }
    /// Copy contiguous ciphertext into the reserved input after native checks.
    pub fn append<S: Store>(
        &mut self,
        r: &Replica<S>,
        ticket: u64,
        bytes: &[u8],
        region: &mut AttachmentRegion,
    ) -> bool {
        let Some(a) = self.active.as_mut() else {
            return false;
        };
        if !region.owns(a.lease) || r.attachment_read_check(&a.pin).is_err() {
            return false;
        }
        let Some(input) = a
            .fetching
            .as_mut()
            .filter(|f| f.ticket == ticket)
            .and_then(|f| f.input.as_mut())
        else {
            return false;
        };
        if input.pending.is_some() {
            return false;
        }
        let Some(end) = input
            .filled
            .checked_add(bytes.len())
            .filter(|e| *e <= input.length)
        else {
            return false;
        };
        let Some(backing) = region.borrow(a.lease) else {
            return false;
        };
        backing[input.filled..end].copy_from_slice(bytes);
        input.filled = end;
        if !bytes.is_empty() {
            a.progress_ms = self.now_ms;
        }
        true
    }
    /// Check completeness/hash, then authenticate the object with the native reader.
    pub fn complete<S: Store>(
        &mut self,
        r: &Replica<S>,
        ticket: u64,
        checksum: Hash,
        region: &mut AttachmentRegion,
    ) -> Result<bool, SessionId> {
        let Some(a) = self.active.as_mut() else {
            return Ok(false);
        };
        if a.fetching.as_ref().is_none_or(|f| f.ticket != ticket) {
            return Ok(false);
        }
        r.attachment_read_check(&a.pin).map_err(|_| a.session)?;
        let bytes = region.borrow(a.lease).ok_or(a.session)?;
        let f = a.fetching.take().ok_or(a.session)?;
        let input = f.input.ok_or(a.session)?;
        if input.pending.is_some()
            || input.filled != input.length
            || mdbn_wire::hash::sha256(&bytes[..input.length]) != checksum
        {
            region.scrub(a.lease);
            return Err(a.session);
        }
        let result = match f.need {
            Need::Manifest { .. } => {
                let result = r.attachment_read_manifest(&mut a.pin, &bytes[..input.length]);
                region.scrub(a.lease);
                result
            }
            Need::Chunk { index, .. } => r
                .attachment_read_chunk_in_place(&mut a.pin, index, &mut bytes[..input.length])
                .map(|span| {
                    a.held = Some(span);
                    a.cursor = 0;
                }),
        };
        if result.is_err() {
            region.scrub(a.lease);
        }
        result.map_err(|error| {
            use mdbn_wire::common::Value;
            let problem = error.problem();
            let mut detail = vec![("cause_code".into(), Value::Text(problem.code.clone()))];
            if let Some(reason) = &problem.reason {
                detail.push(("cause_reason".into(), Value::Text(reason.clone())));
            }
            self.failure = Some((a.session, Value::Map(detail)));
            a.session
        })?;
        a.progress_ms = self.now_ms;
        Ok(true)
    }
    /// Build only one <=1MiB frame immediately before the host's synchronous
    /// admission/encryption/send. Keeping at most one frame avoids output copies
    /// competing with the 8MiB authenticated plaintext allocation.
    pub fn poll<S: Store>(
        &mut self,
        r: &Replica<S>,
        region: &mut AttachmentRegion,
    ) -> Result<Option<(SessionId, Vec<u8>)>, SessionId> {
        self.poll_with(r, region, file_chunk_push_slice)
    }
    /// Emit one typed bounded chunk for the ordinary device ClientApi push path.
    pub(crate) fn poll_chunk<S: Store>(
        &mut self,
        r: &Replica<S>,
        region: &mut AttachmentRegion,
    ) -> Result<Option<(SessionId, FileChunk)>, SessionId> {
        self.poll_with(r, region, |stream, offset, bytes, last| FileChunk {
            stream,
            offset,
            bytes: mdbn_wire::common::Bytes(bytes.to_vec()),
            last,
        })
    }
    // Both transport forms advance and wipe exactly the same authenticated span.
    fn poll_with<S: Store, T>(
        &mut self,
        r: &Replica<S>,
        region: &mut AttachmentRegion,
        emit: impl FnOnce(u64, u64, &[u8], bool) -> T,
    ) -> Result<Option<(SessionId, T)>, SessionId> {
        let Some(a) = self.active.as_mut() else {
            return Ok(None);
        };
        r.attachment_read_check(&a.pin).map_err(|_| a.session)?;
        if !region.owns(a.lease) {
            return Err(a.session);
        }
        if a.fetching.is_some() {
            return Ok(None);
        }
        let available = usize::try_from(WINDOW - (a.sent - a.acked)).map_err(|_| a.session)?;
        if available == 0 {
            return Ok(None);
        }
        let (bytes, offset, end) = match a.held.as_ref() {
            Some(h) => {
                let range = h.range();
                let count = (range.len() - a.cursor).min(FRAME_BYTES).min(available);
                (
                    range.start + a.cursor..range.start + a.cursor + count,
                    h.offset() + a.cursor as u64,
                    a.cursor + count == range.len(),
                )
            }
            None if a.pin.need().is_none() => (0..0, a.sent, true),
            None => return Ok(None),
        };
        a.cursor += bytes.len();
        a.sent = offset + bytes.len() as u64;
        let last = end && a.pin.need().is_none();
        let session = a.session;
        let id = a.id;
        let lease = a.lease;
        if end {
            a.held = None;
            a.cursor = 0;
        }
        if last {
            let a = self.active.take().ok_or(session)?;
            if r.attachment_read_finish(a.pin).is_err() {
                region.release(lease);
                return Err(session);
            }
        }
        let backing = region.borrow(lease).ok_or(session)?;
        let frame = emit(id.0, offset, &backing[bytes], last);
        if last {
            region.release(lease);
        } else if end {
            region.scrub(lease);
        }
        Ok(Some((session, frame)))
    }
}
