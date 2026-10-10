//! `tap-<variant>`: end-to-end self-test of the untrusted-party oracles.
//!
//! A writer sends records over the simulated network to a stand-in log service
//! that, like the real log-service actor, passes every inbound frame through
//! [`World::log_ingress`] and its stored state through [`World::log_state`]. The
//! writer either seals properly (`tap-sealed`, must be clean) or leaks: sends the
//! record in clear (`tap-plain`), DEFLATE-compressed but unencrypted
//! (`tap-deflate`), or with the epoch key in a header (`tap-keyleak`). `tap-silent`
//! declares a log service that never receives anything: the vacuity guard must
//! fire.

use std::any::Any;

use mdbn_wire::hash::h;

use crate::world::{Actor, Ev, World};

/// What the writer does wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// Seals correctly.
    Sealed,
    /// Sends plaintext.
    Plain,
    /// Compresses but forgets to encrypt.
    Deflate,
    /// Puts the key on the wire.
    KeyLeak,
    /// Never sends anything.
    Silent,
}

impl Variant {
    /// Parse `tap-<variant>`.
    pub fn parse(name: &str) -> Option<Variant> {
        Some(match name.strip_prefix("tap-")? {
            "sealed" => Variant::Sealed,
            "plain" => Variant::Plain,
            "deflate" => Variant::Deflate,
            "keyleak" => Variant::KeyLeak,
            "silent" => Variant::Silent,
            _ => return None,
        })
    }
}

struct Service {
    stored: Vec<Vec<u8>>,
}

impl Actor for Service {
    fn name(&self) -> &str {
        "logsvc"
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        if let Ev::Msg { bytes, .. } = ev {
            w.log_ingress("frame", &bytes);
            self.stored.push(bytes);
        }
    }
    fn quiesce(&mut self, w: &mut World) {
        for (i, b) in self.stored.iter().enumerate() {
            w.log_state(&format!("stored item {i}"), b);
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

struct Writer {
    me: u32,
    to: u32,
    variant: Variant,
    key: [u8; 32],
    n: u64,
}

fn keystream_xor(key: &[u8; 32], n: u64, data: &mut [u8]) {
    for (i, chunk) in data.chunks_mut(32).enumerate() {
        let mut m = n.to_le_bytes().to_vec();
        m.extend_from_slice(&(i as u64).to_le_bytes());
        m.extend_from_slice(key);
        let k = h("sim/tapcheck/stream", &m);
        for (b, x) in chunk.iter_mut().zip(k.0) {
            *b ^= x;
        }
    }
}

impl Actor for Writer {
    fn name(&self) -> &str {
        "writer"
    }
    fn handle(&mut self, w: &mut World, ev: Ev) {
        match ev {
            Ev::Start => w.timer(self.me, 10, 1),
            Ev::Timer(1) if self.variant != Variant::Silent && self.n < 20 => {
                self.n += 1;
                let tok = w.shared.tokens.borrow_mut().fresh("writer");
                let plain = format!("---\ntitle: Note {}\n---\n- {tok}\n", self.n).into_bytes();
                // sealed-envelope §3 frame: alg 1 = DEFLATE.
                let data = miniz_oxide::deflate::compress_to_vec(&plain, 6);
                let mut frame = vec![1u8];
                frame.extend_from_slice(&(data.len() as u32).to_be_bytes());
                frame.extend_from_slice(&(plain.len() as u32).to_be_bytes());
                frame.extend_from_slice(&data);
                let mut msg = b"\xa2hdr".to_vec();
                match self.variant {
                    Variant::Plain => msg.extend_from_slice(&plain),
                    Variant::Deflate => msg.extend_from_slice(&frame),
                    Variant::KeyLeak => {
                        msg.extend_from_slice(&self.key);
                        keystream_xor(&self.key, self.n, &mut frame);
                        msg.extend_from_slice(&frame);
                    }
                    Variant::Sealed | Variant::Silent => {
                        keystream_xor(&self.key, self.n, &mut frame);
                        msg.extend_from_slice(&frame);
                    }
                }
                w.send(self.me, self.to, msg);
                w.timer(self.me, 10, 1);
            }
            _ => {}
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

/// Run.
pub fn run(w: &mut World, v: Variant) -> String {
    let mut key = [0u8; 32];
    for b in key.iter_mut() {
        *b = w.rng.below(256) as u8;
    }
    w.shared.tap.borrow_mut().secret("epoch key", &key);
    w.shared
        .tap
        .borrow_mut()
        .marker("frontmatter title", b"title:");
    w.expect_log_service();
    let svc = w.spawn(Box::new(Service { stored: Vec::new() }));
    let me = w.actor_count() as u32;
    w.spawn(Box::new(Writer {
        me,
        to: svc,
        variant: v,
        key,
        n: 0,
    }));
    w.run_chaos(1_000);
    w.quiesce(50, 2, 1_000);
    String::new()
}

#[cfg(test)]
mod tests {
    use crate::oracle::Kind;
    use crate::scenario::{Opts, run_seed};

    fn kinds(name: &str) -> Vec<Kind> {
        let mut k: Vec<Kind> = run_seed(name, 3, &Opts::default())
            .unwrap()
            .violations
            .iter()
            .map(|v| v.kind)
            .collect();
        k.dedup();
        k
    }

    #[test]
    fn reports_missing_party_and_party_counts() {
        use crate::tap::Party;

        let w = crate::world::World::new(3, false);
        w.expect_log_service();
        w.expect_untrusted_party(Party::ControlPlane);
        w.expect_untrusted_party(Party::Relay);
        w.untrusted_bytes(Party::Relay, "ciphertext", &[9; 100]);
        let report = w.report("tap-party-coverage", String::new());
        assert_eq!(report.counters["tap.party.relay"], 1);
        assert_eq!(report.violations.len(), 2);
        assert!(
            report
                .violations
                .iter()
                .any(|v| v.detail.contains("log-service"))
        );
        assert!(
            report
                .violations
                .iter()
                .any(|v| v.detail.contains("control-plane"))
        );
        assert!(report.violations.iter().all(|v| v.kind == Kind::Plaintext));
    }

    #[test]
    fn the_untrusted_party_oracles_fire() {
        assert_eq!(kinds("tap-sealed"), vec![]);
        assert_eq!(kinds("tap-plain"), vec![Kind::Plaintext]);
        assert_eq!(kinds("tap-deflate"), vec![Kind::Plaintext]);
        assert_eq!(kinds("tap-keyleak"), vec![Kind::KeyExposure]);
        assert_eq!(kinds("tap-silent"), vec![Kind::Plaintext]);
    }
}
