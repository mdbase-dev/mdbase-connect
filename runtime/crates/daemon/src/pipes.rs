//! Noise pipes through the relay (`noise_pipe_v1`; control interface note
//! `2026-10-04-control-daemon-grant-feed-and-relay.md` §4).
//!
//! The relay device socket multiplexes pipes. Each pipe is one thin client's
//! `replica-client-api.md` §12.3 session, which the relay forwards opaquely:
//! binary frames `"MDBN" ‖ pipe_id (16 bytes) ‖ payload`, where the payload is
//! `u32be(len) ‖ Noise message`.
//!
//! **Authorization is the daemon's**:
//! - the prologue is built from `pipe_open`'s collection and grant, plus this
//!   device, so a client whose Noise prologue names anything else fails the
//!   handshake;
//! - a pipe is never Host: a nil grant is refused before any handshake;
//! - the session's key must match an active access-list entry under a live lease
//!   ([`crate::access::AccessList::authorize`], via the session handler);
//! - when the lease lapses or the grant is revoked, the pipe is closed.

use tokio::sync::mpsc;

use crate::session::{BoxFuture, Carrier, PROLOGUE_MAGIC, SessionError};

/// Frame tag of a pipe data frame.
pub const TAG: &[u8; 4] = b"MDBN";
/// Largest payload in one pipe frame: `u32be(len)` plus one Noise message.
pub const MAX_PAYLOAD: usize = 4 + crate::noise::MAX_MESSAGE;

/// Split a binary relay frame into `(pipe_id, payload)`. Frames with another tag
/// (`MDBF`/`MDBR` file frames of the legacy channel) return `None`.
pub fn parse_frame(frame: &[u8]) -> Option<([u8; 16], &[u8])> {
    if frame.len() < 20 || &frame[..4] != TAG {
        return None;
    }
    let mut id = [0u8; 16];
    id.copy_from_slice(&frame[4..20]);
    Some((id, &frame[20..]))
}

/// Build a binary relay frame for `pipe_id` carrying one Noise message.
pub fn data_frame(pipe_id: &[u8; 16], noise_message: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(24 + noise_message.len());
    f.extend_from_slice(TAG);
    f.extend_from_slice(pipe_id);
    f.extend_from_slice(&(noise_message.len() as u32).to_be_bytes());
    f.extend_from_slice(noise_message);
    f
}

/// The prologue for a pipe: `"mdbase/v1/client" ‖ collection ‖ grant ‖ device`.
pub fn prologue(collection: &[u8; 16], grant: &[u8; 16], device: &[u8; 16]) -> [u8; 64] {
    let mut p = [0u8; 64];
    p[..16].copy_from_slice(PROLOGUE_MAGIC);
    p[16..32].copy_from_slice(collection);
    p[32..48].copy_from_slice(grant);
    p[48..].copy_from_slice(device);
    p
}

/// Reassembles `u32be(len) ‖ Noise message` records from pipe payloads (a record
/// is normally one frame; this also tolerates splits).
#[derive(Default)]
pub struct PayloadReader {
    buf: Vec<u8>,
}

impl PayloadReader {
    /// Add a payload; returns complete Noise messages.
    pub fn push(&mut self, payload: &[u8]) -> Result<Vec<Vec<u8>>, SessionError> {
        self.buf.extend_from_slice(payload);
        let mut out = Vec::new();
        let mut at = 0;
        while self.buf.len() - at >= 4 {
            let n = u32::from_be_bytes(self.buf[at..at + 4].try_into().expect("4 bytes")) as usize;
            if n > crate::noise::MAX_MESSAGE {
                return Err(SessionError::Protocol("pipe message too large"));
            }
            if self.buf.len() - at - 4 < n {
                break;
            }
            out.push(self.buf[at + 4..at + 4 + n].to_vec());
            at += 4 + n;
        }
        self.buf.drain(..at);
        Ok(out)
    }
}

/// One pipe's side of the socket: payloads in, frames out.
pub struct PipeCarrier {
    /// Pipe ID.
    pub id: [u8; 16],
    inbound: mpsc::Receiver<Vec<u8>>,
    outbound: mpsc::Sender<PipeOut>,
    reader: PayloadReader,
    pending: std::collections::VecDeque<Vec<u8>>,
}

/// What a pipe task sends to the socket writer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeOut {
    /// A binary data frame.
    Frame(Vec<u8>),
    /// Close the pipe with a reason.
    Close([u8; 16], String),
}

impl PipeCarrier {
    /// A carrier fed by `inbound` payloads, writing to `outbound`.
    pub fn new(
        id: [u8; 16],
        inbound: mpsc::Receiver<Vec<u8>>,
        outbound: mpsc::Sender<PipeOut>,
    ) -> Self {
        PipeCarrier {
            id,
            inbound,
            outbound,
            reader: PayloadReader::default(),
            pending: Default::default(),
        }
    }
}

impl Carrier for PipeCarrier {
    fn recv(&mut self) -> BoxFuture<'_, Result<Option<Vec<u8>>, SessionError>> {
        Box::pin(async move {
            loop {
                if let Some(m) = self.pending.pop_front() {
                    return Ok(Some(m));
                }
                let Some(p) = self.inbound.recv().await else {
                    return Ok(None);
                };
                self.pending.extend(self.reader.push(&p)?);
            }
        })
    }

    fn send<'a>(&'a mut self, msg: &'a [u8]) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            self.outbound
                .send(PipeOut::Frame(data_frame(&self.id, msg)))
                .await
                .map_err(|_| SessionError::Protocol("relay socket closed"))
        })
    }

    fn close(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self
                .outbound
                .send(PipeOut::Close(self.id, "closed".into()))
                .await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_and_ignore_other_tags() {
        let id = [9u8; 16];
        let f = data_frame(&id, b"noise");
        let (got, payload) = parse_frame(&f).unwrap();
        assert_eq!(got, id);
        let mut r = PayloadReader::default();
        assert_eq!(r.push(&payload[..3]).unwrap(), Vec::<Vec<u8>>::new());
        assert_eq!(r.push(&payload[3..]).unwrap(), vec![b"noise".to_vec()]);
        let mut legacy = b"MDBF".to_vec();
        legacy.extend_from_slice(&[0; 20]);
        assert!(parse_frame(&legacy).is_none());
        assert!(parse_frame(b"MDBN").is_none());
        let mut huge = PayloadReader::default();
        assert!(huge.push(&(70_000u32).to_be_bytes()).is_err());
    }

    #[test]
    fn prologue_binds_collection_grant_and_device() {
        let p = prologue(&[1; 16], &[2; 16], &[3; 16]);
        let parsed = crate::session::Prologue::parse(&p).unwrap();
        assert_eq!(
            (parsed.collection, parsed.grant, parsed.target),
            ([1; 16], [2; 16], [3; 16])
        );
    }
}
