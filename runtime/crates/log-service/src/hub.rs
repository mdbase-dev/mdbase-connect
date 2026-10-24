//! Connection-level state of one collection: subscriptions (§9) and ephemeral
//! per-record streams (§8).
//!
//! Nothing here is durable (I11). The Durable Object keeps one hub in memory and
//! rebuilds subscriptions from WebSocket attachments after hibernation; the Postgres
//! gateway keeps one hub per collection it serves, with connections routed to it by
//! collection.

use std::collections::BTreeMap;

use mdbn_wire::common::{B16, Bytes, Uuid};
use mdbn_wire::envelope::{Item, ItemKind};
use mdbn_wire::log_service::{
    ClosedPush, HeadPush, ItemsPush, LsPush, SeqItem, StreamEvent, StreamEventKind, StreamMsg,
};
use mdbn_wire::schema::Wire;

use crate::error::{Code, Result, ServiceError};
use crate::limits::*;
use crate::model::CommitNotice;

/// A session (one connection) ID, unique within a host.
pub type SessionId = u64;

/// How a push may be treated under backpressure (§9, §11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushClass {
    /// `items`: may be replaced by a `head` push of the same collection.
    Items,
    /// `head`, `closed`: state; never dropped.
    State,
    /// Ephemeral stream traffic: dropped first.
    Ephemeral,
}

/// A push addressed to a session.
#[derive(Debug, Clone, PartialEq)]
pub struct Push {
    /// Target.
    pub to: SessionId,
    /// Frame payload.
    pub push: LsPush,
    /// Class.
    pub class: PushClass,
    /// For `Items`: the equivalent `head` push used when coalescing.
    pub fallback: Option<LsPush>,
}

#[derive(Debug, Clone)]
struct Sub {
    device: Option<Uuid>,
    inline_bytes: u64,
}

#[derive(Debug, Clone)]
struct Member {
    device: Uuid,
    last_active: i64,
    msgs_milli: u64,
    bytes: u64,
    at: i64,
}

/// Subscriptions and streams of one collection.
#[derive(Debug)]
pub struct Hub {
    collection: Uuid,
    subs: BTreeMap<SessionId, Sub>,
    streams: BTreeMap<B16, BTreeMap<SessionId, Member>>,
    joined: BTreeMap<SessionId, usize>,
}

fn push(kind: &str, payload: impl Wire) -> LsPush {
    LsPush {
        kind: kind.to_string(),
        payload: payload.to_cbor(),
    }
}

impl Hub {
    /// A hub for one collection.
    pub fn new(collection: Uuid) -> Self {
        Hub {
            collection,
            subs: BTreeMap::new(),
            streams: BTreeMap::new(),
            joined: BTreeMap::new(),
        }
    }

    /// Number of subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.subs.len()
    }

    /// Subscribe (one per connection per collection; a second replaces the first).
    pub fn subscribe(&mut self, s: SessionId, device: Option<Uuid>, inline_bytes: Option<u64>) {
        self.subs.insert(
            s,
            Sub {
                device,
                inline_bytes: inline_bytes.unwrap_or(DEFAULT_INLINE_BYTES),
            },
        );
    }

    /// Unsubscribe.
    pub fn unsubscribe(&mut self, s: SessionId) {
        self.subs.remove(&s);
    }

    /// Pushes after a commit. `items` are the new items when the committer has them
    /// (DO); otherwise only `head` pushes are produced unless `items` is given.
    pub fn on_commit(&mut self, n: &CommitNotice, items: &[(u64, Vec<u8>)]) -> Vec<Push> {
        let mut out = Vec::new();
        if n.gone {
            for &s in self.subs.keys() {
                out.push(Push {
                    to: s,
                    push: push(
                        "closed",
                        ClosedPush {
                            collection: n.collection,
                            reason: "gone".into(),
                        },
                    ),
                    class: PushClass::State,
                    fallback: None,
                });
            }
            self.subs.clear();
            let sessions: Vec<_> = self.joined.keys().copied().collect();
            for s in sessions {
                self.disconnect(s);
            }
            return out;
        }
        out.extend(self.close_devices(&n.revoked, "forbidden"));
        if n.first == 0 {
            return out;
        }
        let head = HeadPush {
            collection: n.collection,
            head: n.head,
            head_chain: n.head_chain,
        };
        let size: u64 = items.iter().map(|(_, b)| b.len() as u64).sum();
        let full = !items.is_empty() && items[0].0 == n.first && items.last().unwrap().0 == n.head;
        for (&s, sub) in &self.subs {
            if full && size <= sub.inline_bytes {
                out.push(Push {
                    to: s,
                    push: push(
                        "items",
                        ItemsPush {
                            collection: n.collection,
                            items: items
                                .iter()
                                .map(|(seq, b)| SeqItem {
                                    seq: *seq,
                                    item: Bytes(b.clone()),
                                })
                                .collect(),
                            head: n.head,
                            head_chain: n.head_chain,
                        },
                    ),
                    class: PushClass::Items,
                    fallback: Some(push("head", head.clone())),
                });
            } else {
                out.push(Push {
                    to: s,
                    push: push("head", head.clone()),
                    class: PushClass::State,
                    fallback: None,
                });
            }
        }
        out
    }

    /// Close the subscriptions and streams of revoked devices.
    pub fn close_devices(&mut self, devices: &[Uuid], reason: &str) -> Vec<Push> {
        if devices.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let hit: Vec<SessionId> = self
            .subs
            .iter()
            .filter(|(_, s)| s.device.is_some_and(|d| devices.contains(&d)))
            .map(|(k, _)| *k)
            .collect();
        for s in &hit {
            self.subs.remove(s);
            out.push(Push {
                to: *s,
                push: push(
                    "closed",
                    ClosedPush {
                        collection: self.collection,
                        reason: reason.into(),
                    },
                ),
                class: PushClass::State,
                fallback: None,
            });
        }
        let members: Vec<SessionId> = self
            .streams
            .values()
            .flat_map(|m| {
                m.iter()
                    .filter(|(_, v)| devices.contains(&v.device))
                    .map(|(k, _)| *k)
            })
            .collect();
        for s in members {
            out.extend(self.disconnect(s));
        }
        out
    }

    fn event(
        &self,
        stream: &B16,
        device: Uuid,
        ev: StreamEventKind,
        except: SessionId,
    ) -> Vec<Push> {
        let Some(m) = self.streams.get(stream) else {
            return vec![];
        };
        m.keys()
            .filter(|s| **s != except)
            .map(|s| Push {
                to: *s,
                push: push(
                    "stream_event",
                    StreamEvent {
                        collection: self.collection,
                        stream: *stream,
                        device,
                        event: ev,
                    },
                ),
                class: PushClass::Ephemeral,
                fallback: None,
            })
            .collect()
    }

    /// Join a stream. Returns the devices already joined and the `joined` events.
    pub fn join(
        &mut self,
        s: SessionId,
        device: Uuid,
        stream: B16,
        now: i64,
    ) -> Result<(Vec<Uuid>, Vec<Push>)> {
        let mut out = self.expire(now);
        let rl = |what: &str| ServiceError::reason(Code::RateLimited, what).retry(1000);
        let exists = self
            .streams
            .get(&stream)
            .is_some_and(|m| m.contains_key(&s));
        if !exists {
            if !self.streams.contains_key(&stream) && self.streams.len() >= EPH_MAX_STREAMS {
                return Err(rl("streams_per_collection"));
            }
            if self
                .streams
                .get(&stream)
                .is_some_and(|m| m.len() >= EPH_MAX_SESSIONS)
            {
                return Err(rl("sessions_per_stream"));
            }
            if self.joined.get(&s).copied().unwrap_or(0) >= EPH_MAX_STREAMS_PER_CONN {
                return Err(rl("streams_per_connection"));
            }
        }
        let others: Vec<Uuid> = self
            .streams
            .get(&stream)
            .map(|m| {
                m.iter()
                    .filter(|(k, _)| **k != s)
                    .map(|(_, v)| v.device)
                    .collect()
            })
            .unwrap_or_default();
        let m = self.streams.entry(stream).or_default();
        m.insert(
            s,
            Member {
                device,
                last_active: now,
                msgs_milli: EPH_RATE_MSGS * 1000,
                bytes: EPH_RATE_BYTES,
                at: now,
            },
        );
        if !exists {
            *self.joined.entry(s).or_default() += 1;
            out.extend(self.event(&stream, device, StreamEventKind::Joined, s));
        }
        Ok((others, out))
    }

    /// Leave a stream.
    pub fn leave(&mut self, s: SessionId, stream: &B16) -> Vec<Push> {
        let Some(m) = self.streams.get_mut(stream) else {
            return vec![];
        };
        let Some(v) = m.remove(&s) else { return vec![] };
        if let Some(j) = self.joined.get_mut(&s) {
            *j -= 1;
            if *j == 0 {
                self.joined.remove(&s);
            }
        }
        let out = self.event(stream, v.device, StreamEventKind::Left, s);
        if self.streams.get(stream).is_some_and(|m| m.is_empty()) {
            self.streams.remove(stream);
        }
        out
    }

    /// Send a message: validates the ephemeral envelope and the limits, and fans out
    /// to every other joined session. Returns how many sessions it was queued for.
    pub fn send(
        &mut self,
        s: SessionId,
        stream: B16,
        message: Vec<u8>,
        now: i64,
    ) -> Result<(u64, Vec<Push>)> {
        self.send_with_budget(s, stream, message, now, &crate::decode::Budget::default())
    }

    /// Send an ephemeral envelope with its enclosing frame's decode budget.
    pub fn send_with_budget(
        &mut self,
        s: SessionId,
        stream: B16,
        message: Vec<u8>,
        now: i64,
        budget: &crate::decode::Budget,
    ) -> Result<(u64, Vec<Push>)> {
        if message.len() > EPH_MAX_MESSAGE {
            return Err(ServiceError::reason(Code::TooLarge, "message"));
        }
        let mut out = self.expire(now);
        let m = self
            .streams
            .get_mut(&stream)
            .and_then(|m| m.get_mut(&s))
            .ok_or_else(|| ServiceError::reason(Code::Forbidden, "not_joined"))?;
        let it = budget.wire::<Item>(&message)?;
        if it.check_shape().is_err()
            || it.kind != ItemKind::Ephemeral
            || it.collection != self.collection
            || it.stream != Some(stream)
            || it.signer != Some(m.device)
        {
            return Err(ServiceError::invalid("shape").msg("ephemeral envelope"));
        }
        // Token buckets: 30 msgs/s and 256 KiB/s, one second of burst.
        let dt = (now - m.at).clamp(0, 60_000) as u64;
        m.msgs_milli = (m.msgs_milli + dt * EPH_RATE_MSGS).min(EPH_RATE_MSGS * 1000);
        m.bytes = (m.bytes + dt * EPH_RATE_BYTES / 1000).min(EPH_RATE_BYTES);
        m.at = now;
        let len = message.len() as u64;
        if m.msgs_milli < 1000 || m.bytes < len {
            let wait = ((1000 - m.msgs_milli.min(1000)) / EPH_RATE_MSGS)
                .max(len.saturating_sub(m.bytes) * 1000 / EPH_RATE_BYTES)
                .max(1);
            return Err(ServiceError::reason(Code::RateLimited, "stream_rate").retry(wait));
        }
        m.msgs_milli -= 1000;
        m.bytes -= len;
        m.last_active = now;
        let from = m.device;
        let msg = StreamMsg {
            collection: self.collection,
            stream,
            from,
            message: Bytes(message),
        };
        let targets: Vec<SessionId> = self.streams[&stream]
            .keys()
            .filter(|k| **k != s)
            .copied()
            .collect();
        for t in &targets {
            out.push(Push {
                to: *t,
                push: push("stream_msg", msg.clone()),
                class: PushClass::Ephemeral,
                fallback: None,
            });
        }
        Ok((targets.len() as u64, out))
    }

    /// A connection closed: leave everything.
    pub fn disconnect(&mut self, s: SessionId) -> Vec<Push> {
        self.subs.remove(&s);
        let streams: Vec<B16> = self
            .streams
            .iter()
            .filter(|(_, m)| m.contains_key(&s))
            .map(|(k, _)| *k)
            .collect();
        let mut out = Vec::new();
        for st in streams {
            out.extend(self.leave(s, &st));
        }
        self.joined.remove(&s);
        out
    }

    /// Sessions idle for 60 s leave their streams.
    pub fn expire(&mut self, now: i64) -> Vec<Push> {
        let idle: Vec<(SessionId, B16)> = self
            .streams
            .iter()
            .flat_map(|(st, m)| {
                m.iter()
                    .filter(|(_, v)| now - v.last_active > EPH_IDLE_MS)
                    .map(move |(s, _)| (*s, *st))
            })
            .collect();
        let mut out = Vec::new();
        for (s, st) in idle {
            out.extend(self.leave(s, &st));
        }
        out
    }

    /// For hosts that rebuild state: is the session subscribed?
    pub fn is_subscribed(&self, s: SessionId) -> bool {
        self.subs.contains_key(&s)
    }

    /// The session's subscription `inline_bytes`, if subscribed (hosts persist it
    /// across hibernation).
    pub fn subscription(&self, s: SessionId) -> Option<u64> {
        self.subs.get(&s).map(|x| x.inline_bytes)
    }

    /// The collection.
    pub fn collection(&self) -> Uuid {
        self.collection
    }
}

/// The size a push's frame will have on the wire (for queue accounting).
pub fn frame_bytes(p: &LsPush) -> Vec<u8> {
    mdbn_wire::log_service::LsFrame::Push(p.clone())
        .to_bytes()
        .expect("push encodes")
}
