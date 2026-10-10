//! One ephemeral authenticated attachment stream per DO. No file-sized buffers,
//! no plaintext in SQL: move one verified chunk and drain one app frame per poll.
use crate::attachment_region::{AttachmentRegion, RegionLease, RegionOwner};
use crate::runtime::MAX_OUT_FRAME;
use mdbn_replica::api::{ApiResult, ErrorCode, SessionId, StreamId, Target};
use mdbn_replica::attachments::{
    AuthenticatedReadSpan, MAX_SEALED_CHUNK, MAX_SEALED_MANIFEST, Need,
};
use mdbn_replica::frames::file_chunk_push_slice;
use mdbn_replica::replica::HostedAttachmentRead;
use mdbn_replica::{Replica, Store};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::Hash;
use mdbn_wire::schema::Wire;

const FRAME_BYTES: usize = MAX_OUT_FRAME - 128;
const WINDOW: u64 = 8 << 20;
const MAX_ID: u64 = (1 << 53) - 1;
const IDLE_MS: i64 = 60_000;

#[derive(Debug)]
pub(crate) struct ObjectRead {
    pub ticket: u64,
    pub session: SessionId,
    pub address: Hash,
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
    pin: HostedAttachmentRead,
    lease: RegionLease,
    held: Option<AuthenticatedReadSpan>,
    cursor: usize,
    sent: u64,
    acked: u64,
    fetching: Option<Fetching>,
    progress_ms: i64,
}

pub(crate) struct FileReads {
    active: Option<Reading>,
    next_stream: u64,
    next_ticket: u64,
    now_ms: i64,
}
fn bad(message: &'static str) -> mdbn_replica::api::ApiError {
    ErrorCode::InvalidRequest.err(message)
}
pub(crate) fn busy() -> mdbn_replica::api::ApiError {
    let mut error = ErrorCode::Unavailable
        .err_with_reason("hosted_chunk_busy", "hosted attachment region is busy");
    error.0.details = Some(mdbn_wire::common::Value::Map(vec![(
        "retry_after_ms".into(),
        mdbn_wire::common::Value::Int(1000),
    )]));
    error
}

impl FileReads {
    pub fn new(now_ms: i64) -> Self {
        Self {
            active: None,
            next_stream: 1,
            next_ticket: 1,
            now_ms,
        }
    }
    pub fn active_session(&self) -> Option<SessionId> {
        self.active.as_ref().map(|a| a.session)
    }
    pub fn deadline(&self) -> Option<i64> {
        self.active
            .as_ref()
            .map(|a| a.progress_ms.saturating_add(IDLE_MS))
    }
    pub fn tick(&mut self, now_ms: i64, region: &mut AttachmentRegion) -> Option<SessionId> {
        self.now_ms = self.now_ms.max(now_ms);
        if self.deadline().is_some_and(|t| t <= self.now_ms) {
            let a = self.active.take()?;
            region.release(a.lease);
            return Some(a.session);
        }
        None
    }
    pub fn start<S: Store>(
        &mut self,
        r: &mut Replica<S>,
        session: SessionId,
        target: Target,
        range: Option<(u64, u64)>,
        revision: Option<Hash>,
        region: &mut AttachmentRegion,
    ) -> ApiResult<Cbor> {
        // Admission precedes capacity reporting and pin creation uses confirmed metadata.
        let pin = r.hosted_attachment_read(session, target, range, revision)?;
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
        let response = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(id.0)),
            (Cbor::Uint(1), pin.view().to_cbor()),
        ]);
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
        Ok(response)
    }
    pub fn ack<S: Store>(
        &mut self,
        r: &Replica<S>,
        session: SessionId,
        id: StreamId,
        offset: u64,
        region: &AttachmentRegion,
    ) -> ApiResult<Cbor> {
        let a = self
            .active
            .as_mut()
            .filter(|a| a.session == session && a.id == id)
            .ok_or_else(|| ErrorCode::NotFound.err("file stream is not active"))?;
        r.hosted_attachment_read_check(&a.pin)?;
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
        Ok(Cbor::Null)
    }
    pub fn cancel(
        &mut self,
        session: SessionId,
        id: StreamId,
        region: &mut AttachmentRegion,
    ) -> ApiResult<Cbor> {
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.session == session && a.id == id)
            && let Some(a) = self.active.take()
        {
            region.release(a.lease);
        }
        // Idempotent cancellation exposes no other session's stream.
        Ok(Cbor::Null)
    }
    pub fn close(&mut self, session: SessionId, region: &mut AttachmentRegion) {
        if self.active.as_ref().is_some_and(|a| a.session == session)
            && let Some(a) = self.active.take()
        {
            region.release(a.lease);
        }
    }
    pub fn retire_transport(&mut self, region: &mut AttachmentRegion) {
        if let Some(a) = self.active.as_mut()
            && a.fetching.take().is_some()
        {
            region.scrub(a.lease);
        }
    }
    pub fn object<S: Store>(
        &mut self,
        r: &Replica<S>,
        region: &AttachmentRegion,
    ) -> Result<Option<ObjectRead>, SessionId> {
        let Some(a) = self.active.as_mut() else {
            return Ok(None);
        };
        r.hosted_attachment_read_check(&a.pin)
            .map_err(|_| a.session)?;
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
    pub fn allowed<S: Store>(
        &self,
        r: &Replica<S>,
        ticket: u64,
        region: &AttachmentRegion,
    ) -> bool {
        self.active.as_ref().is_some_and(|a| {
            region.owns(a.lease)
                && a.fetching.as_ref().is_some_and(|f| f.ticket == ticket)
                && r.hosted_attachment_read_check(&a.pin).is_ok()
        })
    }
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
        if !region.owns(a.lease) || r.hosted_attachment_read_check(&a.pin).is_err() {
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
        r.hosted_attachment_read_check(&a.pin).ok()?;
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
        if !region.owns(a.lease) || r.hosted_attachment_read_check(&a.pin).is_err() {
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
        if !region.owns(a.lease) || r.hosted_attachment_read_check(&a.pin).is_err() {
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
        r.hosted_attachment_read_check(&a.pin)
            .map_err(|_| a.session)?;
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
                let result = r.hosted_attachment_manifest(&mut a.pin, &bytes[..input.length]);
                region.scrub(a.lease);
                result
            }
            Need::Chunk { index, .. } => r
                .hosted_attachment_chunk_in_place(&mut a.pin, index, &mut bytes[..input.length])
                .map(|span| {
                    a.held = Some(span);
                    a.cursor = 0;
                }),
        };
        if result.is_err() {
            region.scrub(a.lease);
        }
        result.map_err(|_| a.session)?;
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
        let Some(a) = self.active.as_mut() else {
            return Ok(None);
        };
        r.hosted_attachment_read_check(&a.pin)
            .map_err(|_| a.session)?;
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
            if r.hosted_attachment_finish(a.pin).is_err() {
                region.release(lease);
                return Err(session);
            }
        }
        let backing = region.borrow(lease).ok_or(session)?;
        let frame = file_chunk_push_slice(id.0, offset, &backing[bytes], last);
        if last {
            region.release(lease);
        } else if end {
            region.scrub(lease);
        }
        Ok(Some((session, frame)))
    }
}
