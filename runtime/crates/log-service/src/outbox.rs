//! A connection's bounded outbound queue (§9 coalescing, §8 receive buffer, §11).
//!
//! - Responses are always queued.
//! - Log pushes share a 1 MiB budget. When it would overflow, the queued `items`
//!   pushes of that collection are dropped and one `head` push with the latest head
//!   stays: a head is idempotent state, so nothing is lost; the replica reads.
//! - Ephemeral messages have their own 256 KiB budget and drop oldest first.

use std::collections::VecDeque;

use mdbn_wire::cbor::Cbor;
use mdbn_wire::log_service::{LsFrame, LsPush};
use mdbn_wire::schema::Wire;

use crate::hub::{Push, PushClass};
use crate::limits::{EPH_BUFFER_BYTES, PUSH_QUEUE_BYTES};

#[derive(Debug)]
struct Queued {
    bytes: Vec<u8>,
    class: Option<PushClass>,
    collection: Option<Vec<u8>>,
}

/// Outbound queue for one connection.
#[derive(Debug, Default)]
pub struct Outbox {
    q: VecDeque<Queued>,
    log_bytes: usize,
    eph_bytes: usize,
    /// Pushes dropped or coalesced so far (observability).
    pub dropped: u64,
}

fn collection_of(p: &LsPush) -> Option<Vec<u8>> {
    match &p.payload {
        Cbor::Map(m) => m
            .iter()
            .find(|(k, _)| *k == Cbor::Uint(0))
            .and_then(|(_, v)| match v {
                Cbor::Bytes(b) => Some(b.clone()),
                _ => None,
            }),
        _ => None,
    }
}

fn encode(p: &LsPush) -> Vec<u8> {
    LsFrame::Push(p.clone()).to_bytes().expect("push encodes")
}

impl Outbox {
    /// Queue a response frame.
    pub fn response(&mut self, frame: Vec<u8>) {
        self.q.push_back(Queued {
            bytes: frame,
            class: None,
            collection: None,
        });
    }

    /// Queue a push, applying the budgets.
    pub fn push(&mut self, p: &Push) {
        let bytes = encode(&p.push);
        let col = collection_of(&p.push);
        match p.class {
            PushClass::Ephemeral => {
                while self.eph_bytes + bytes.len() > EPH_BUFFER_BYTES {
                    let Some(i) = self
                        .q
                        .iter()
                        .position(|e| e.class == Some(PushClass::Ephemeral))
                    else {
                        break;
                    };
                    let e = self.q.remove(i).unwrap();
                    self.eph_bytes -= e.bytes.len();
                    self.dropped += 1;
                }
                self.eph_bytes += bytes.len();
            }
            PushClass::Items | PushClass::State => {
                if self.log_bytes + bytes.len() > PUSH_QUEUE_BYTES {
                    // Coalesce: drop this collection's queued log pushes, keep one head.
                    let before = self.q.len();
                    let mut freed = 0;
                    self.q.retain(|e| {
                        let drop =
                            matches!(e.class, Some(PushClass::Items) | Some(PushClass::State))
                                && e.collection == col
                                && !is_closed(&e.bytes);
                        if drop {
                            freed += e.bytes.len();
                        }
                        !drop
                    });
                    self.log_bytes -= freed;
                    self.dropped += (before - self.q.len()) as u64;
                    let head = match (&p.class, &p.fallback) {
                        (PushClass::Items, Some(f)) => encode(f),
                        _ => bytes,
                    };
                    self.log_bytes += head.len();
                    self.q.push_back(Queued {
                        bytes: head,
                        class: Some(PushClass::State),
                        collection: col,
                    });
                    return;
                }
                self.log_bytes += bytes.len();
            }
        }
        self.q.push_back(Queued {
            bytes,
            class: Some(p.class),
            collection: col,
        });
    }

    /// Next frame to write.
    pub fn pop(&mut self) -> Option<Vec<u8>> {
        let e = self.q.pop_front()?;
        match e.class {
            Some(PushClass::Ephemeral) => self.eph_bytes -= e.bytes.len(),
            Some(_) => self.log_bytes -= e.bytes.len(),
            None => {}
        }
        Some(e.bytes)
    }

    /// Queued frames.
    pub fn len(&self) -> usize {
        self.q.len()
    }

    /// Empty.
    pub fn is_empty(&self) -> bool {
        self.q.is_empty()
    }
}

fn is_closed(frame: &[u8]) -> bool {
    matches!(crate::decode::wire::<LsFrame>(frame), Ok(LsFrame::Push(p)) if p.kind == "closed")
}
