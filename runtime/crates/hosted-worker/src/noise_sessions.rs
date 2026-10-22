//! Noise IK responder sessions for app clients of the hosted Worker
//! (`replica-client-api.md` §12.2–12.3), over the shared `mdbn-noise` crate.
//!
//! RAM only: sessions live in this engine instance and are gone on DO eviction or a
//! new wake (the client re-handshakes). Entropy is the host's CSPRNG (the Worker's
//! `crypto.getRandomValues`), supplied per handshake; the static secret comes from
//! custody per open and is never stored here beyond the responder's own copy, which
//! is dropped with the handshake. A session that errors is discarded: Noise state is
//! single-use. This authenticates a peer key and payload, not admission: the host
//! admits each operation separately.

use std::collections::BTreeMap;

use mdbn_noise::{NoiseError, Responder, Transport};
use mdbn_wire::common::{B16, B32, Uuid};

/// Initial app peer proof from a real Noise message 1 and its authenticated
/// prologue. Relative to the supplied responder secret/prologue, not deployment
/// identity, signed original grant, current CP authority or a serving lease.
/// No restored attachment, grant projection or host-supplied key can construct it.
#[derive(Clone)]
pub struct VerifiedAppCaller {
    collection: Uuid,
    grant: Uuid,
    target_device: Uuid,
    client_pk: B32,
    responder_pk: B32,
}

impl std::fmt::Debug for VerifiedAppCaller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VerifiedAppCaller { .. }")
    }
}

impl VerifiedAppCaller {
    /// Collection named in the Noise-authenticated app prologue.
    pub fn collection(&self) -> Uuid {
        self.collection
    }
    /// LS grant UUID, not a CP grants.id or device UUID interpretation.
    pub fn grant(&self) -> Uuid {
        self.grant
    }
    /// Target service device named in that prologue, not verified deployment ID.
    pub fn target_device(&self) -> Uuid {
        self.target_device
    }
    /// Actual initiator static key authenticated by Noise, not a request key.
    pub fn client_pk(&self) -> B32 {
        self.client_pk
    }
    /// Public key derived from the actual supplied responder secret. Not a
    /// deployed device identity until compared with independent native evidence.
    pub fn responder_pk(&self) -> B32 {
        self.responder_pk
    }
}

#[derive(Clone, Copy)]
struct AppScope {
    collection: Uuid,
    grant: Uuid,
    target_device: Uuid,
    responder_pk: B32,
}
impl AppScope {
    fn parse(prologue: &[u8], static_secret: &[u8; 32]) -> Option<Self> {
        if prologue.len() != 64 || &prologue[..16] != b"mdbase/v1/client" {
            return None;
        }
        let collection = B16(prologue[16..32].try_into().ok()?);
        let grant = B16(prologue[32..48].try_into().ok()?);
        let target_device = B16(prologue[48..64].try_into().ok()?);
        if [collection, grant, target_device]
            .iter()
            .any(|id| id.0 == [0; 16])
        {
            return None;
        }
        Some(Self {
            collection,
            grant,
            target_device,
            responder_pk: B32(mdbn_noise::public_key(static_secret)),
        })
    }
    fn caller(self, peer: [u8; 32]) -> VerifiedAppCaller {
        VerifiedAppCaller {
            collection: self.collection,
            grant: self.grant,
            target_device: self.target_device,
            client_pk: B32(peer),
            responder_pk: self.responder_pk,
        }
    }
}

/// At most this many concurrent sessions (handshaking or established) per engine.
pub const MAX_SESSIONS: usize = 64;

enum Session {
    Handshake {
        responder: Box<Responder>,
        scope: Option<AppScope>,
        caller: Option<VerifiedAppCaller>,
    },
    Open {
        transport: Box<Transport>,
        caller: Option<VerifiedAppCaller>,
    },
}

/// The engine's Noise sessions, by host-visible handle (never reused).
#[derive(Default)]
pub struct NoiseSessions {
    next: u32,
    sessions: BTreeMap<u32, Session>,
}

impl NoiseSessions {
    /// Start a responder handshake with this wake's static secret and the
    /// collection-bound prologue; `None` when full.
    pub fn start(&mut self, static_secret: &[u8; 32], prologue: &[u8]) -> Option<u32> {
        if self.sessions.len() >= MAX_SESSIONS {
            return None;
        }
        self.next = self.next.checked_add(1)?;
        let h = self.next;
        self.sessions.insert(
            h,
            Session::Handshake {
                responder: Box::new(Responder::new(static_secret, prologue)),
                scope: AppScope::parse(prologue, static_secret),
                caller: None,
            },
        );
        Some(h)
    }

    /// Message 1: its payload and the authenticated initiator static key.
    pub fn read1(&mut self, h: u32, msg: &[u8]) -> Result<(Vec<u8>, [u8; 32]), NoiseError> {
        let r = match self.sessions.get_mut(&h) {
            Some(Session::Handshake {
                responder,
                scope,
                caller,
            }) => {
                // A failed/repeated handshake cannot leave an earlier witness.
                *caller = None;
                let result = responder.read_message_1(msg);
                if let Ok((_, peer)) = &result {
                    *caller = scope.map(|s| s.caller(*peer));
                }
                result
            }
            _ => Err(NoiseError::Decrypt),
        };
        if r.is_err() {
            self.sessions.remove(&h);
        }
        r
    }

    /// Message 2 with `payload`, using a fresh host-CSPRNG ephemeral; the session
    /// becomes a transport.
    pub fn write2(
        &mut self,
        h: u32,
        ephemeral: &[u8; 32],
        payload: &[u8],
    ) -> Result<Vec<u8>, NoiseError> {
        let Some(Session::Handshake {
            responder, caller, ..
        }) = self.sessions.remove(&h)
        else {
            return Err(NoiseError::Decrypt);
        };
        let (m2, t) = (*responder).write_message_2(ephemeral, payload)?;
        self.sessions.insert(
            h,
            Session::Open {
                transport: Box::new(t),
                caller,
            },
        );
        Ok(m2)
    }

    /// Encrypt one outgoing message; an error ends the session.
    pub fn seal(&mut self, h: u32, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let r = match self.sessions.get_mut(&h) {
            Some(Session::Open { transport, .. }) => transport.seal(plaintext),
            _ => Err(NoiseError::Decrypt),
        };
        if r.is_err() {
            self.sessions.remove(&h);
        }
        r
    }

    /// Decrypt one incoming message; an error ends the session.
    pub fn open(&mut self, h: u32, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let r = match self.sessions.get_mut(&h) {
            Some(Session::Open { transport, .. }) => transport.open(message),
            _ => Err(NoiseError::Decrypt),
        };
        if r.is_err() {
            self.sessions.remove(&h);
        }
        r
    }

    /// The authenticated peer static key of an established session.
    pub fn peer(&self, h: u32) -> Option<[u8; 32]> {
        match self.sessions.get(&h) {
            Some(Session::Open { transport, .. }) => Some(transport.remote_static),
            _ => None,
        }
    }

    /// Observe a real message-1 verified app caller while its native Noise
    /// session remains present. Available before message 2 for hello admission.
    /// Ordinary arbitrary prologues still work but never yield an app witness.
    /// A clone is historical proof, not session liveness/current authority; this
    /// observer returns None after error/drop/clear or on a new engine instance.
    pub fn app_caller(&self, h: u32) -> Option<VerifiedAppCaller> {
        match self.sessions.get(&h) {
            Some(Session::Handshake { caller, .. } | Session::Open { caller, .. }) => {
                caller.clone()
            }
            None => None,
        }
    }

    /// End a session (socket closed, admission denied, wake ended).
    pub fn drop_session(&mut self, h: u32) {
        self.sessions.remove(&h);
    }

    /// End every session.
    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// Live sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// No live sessions.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_noise::{Initiator, public_key};

    #[test]
    fn a_client_handshakes_and_exchanges_messages() {
        let server = [7u8; 32];
        let client = [9u8; 32];
        let mut s = NoiseSessions::default();
        let h = s.start(&server, b"mdbase/v1/hosted:collection").unwrap();
        let mut i = Initiator::new(
            &client,
            &public_key(&server),
            b"mdbase/v1/hosted:collection",
        );
        let m1 = i.write_message_1(&[1; 32], b"hello").unwrap();
        let (payload, peer) = s.read1(h, &m1).unwrap();
        assert_eq!(
            (payload.as_slice(), peer),
            (&b"hello"[..], public_key(&client))
        );
        let m2 = s.write2(h, &[2; 32], b"welcome").unwrap();
        let (p2, mut t) = i.read_message_2(&m2).unwrap();
        assert_eq!(p2, b"welcome");
        assert_eq!(s.peer(h), Some(public_key(&client)));
        let c = t.seal(b"frame").unwrap();
        assert_eq!(s.open(h, &c).unwrap(), b"frame");
        let r = s.seal(h, b"reply").unwrap();
        assert_eq!(t.open(&r).unwrap(), b"reply");
    }

    #[test]
    fn errors_discard_the_session_and_prologue_binds() {
        let server = [7u8; 32];
        let mut s = NoiseSessions::default();
        let h = s.start(&server, b"collection A").unwrap();
        let mut i = Initiator::new(&[9; 32], &public_key(&server), b"collection B");
        let m1 = i.write_message_1(&[1; 32], b"x").unwrap();
        assert!(s.read1(h, &m1).is_err(), "another collection's prologue");
        assert!(s.is_empty(), "discarded");
        // A tampered transport message ends the session.
        let h = s.start(&server, b"p").unwrap();
        let mut i = Initiator::new(&[9; 32], &public_key(&server), b"p");
        let m1 = i.write_message_1(&[1; 32], b"").unwrap();
        s.read1(h, &m1).unwrap();
        let m2 = s.write2(h, &[2; 32], b"").unwrap();
        let (_, mut t) = i.read_message_2(&m2).unwrap();
        let mut c = t.seal(b"frame").unwrap();
        c[0] ^= 1;
        assert!(s.open(h, &c).is_err());
        assert!(s.open(h, &t.seal(b"next").unwrap()).is_err(), "gone");
        // Not before the handshake; bounded; handles never reused.
        let h = s.start(&server, b"p").unwrap();
        assert!(s.seal(h, b"early").is_err());
        let mut full = NoiseSessions::default();
        for _ in 0..MAX_SESSIONS {
            full.start(&server, b"p").unwrap();
        }
        assert!(full.start(&server, b"p").is_none());
        full.clear();
        assert_eq!(full.start(&server, b"p"), Some(MAX_SESSIONS as u32 + 1));
    }
}
