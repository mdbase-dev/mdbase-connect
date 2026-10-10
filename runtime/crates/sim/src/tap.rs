//! The untrusted-party tap: the no-plaintext and no-key-material oracles
//! (plaintext oracle).
//!
//! **Every byte sequence an untrusted party receives or stores goes through
//! [`Tap::scan`]**: frames arriving at the log service (items of every kind,
//! objects, snapshot pointers, stream messages), the service's error strings and
//! logs, and at the end of a run its entire stored state. For private (end-to-end)
//! collections the relay, control plane and any hosted replica are untrusted
//! parties too: none may receive content plaintext or secret key material.
//! The simulator's log-service actor calls [`crate::world::World::log_ingress`]
//! for each inbound frame and [`crate::world::World::log_state`] for its final
//! state; a scenario that declares a log service and scanned nothing fails
//! ([`Tap::expected`]), so the oracle can never be silently vacuous again.
//!
//! What counts as a hit:
//! - **plaintext:** a content token (`tk<N>x`), or any registered marker (paths,
//!   field names, body phrases, record-ID bytes). Scanned in the raw bytes, and in
//!   the inflated contents of anything that parses as a `sealed-envelope.md` §3
//!   frame with `alg = 1` (DEFLATE), so compressed-but-unencrypted payloads are
//!   caught;
//! - **key material:** any registered secret (epoch keys, device secret keys,
//!   recovery keys), raw, hex or base64/base64url-encoded (including secrets
//!   embedded inside a larger encoded payload), at a party that must never hold it.
//!
//! [`World::report`](crate::world::World::report) turns every hit into a
//! violation, for every scenario.

use crate::oracle::{Kind, tokens_in};

/// A party the protocol does not trust with content or keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Party {
    /// The blind log service: no plaintext, no keys, ever.
    LogService,
    /// The hosted replica of a private collection: no plaintext or keys.
    HostedPrivate,
    /// The routing relay: only encrypted transport payloads and public metadata.
    Relay,
    /// Enrolment, routing, grants and approval transport: public metadata only.
    ControlPlane,
}

impl Party {
    /// Stable name used in reports and counters.
    pub fn name(self) -> &'static str {
        match self {
            Party::LogService => "log-service",
            Party::HostedPrivate => "hosted-replica(private)",
            Party::Relay => "relay",
            Party::ControlPlane => "control-plane",
        }
    }
}

/// One hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    /// Plaintext or key exposure.
    pub kind: Kind,
    /// Description.
    pub detail: String,
}

/// The tap.
#[derive(Debug, Clone, Default)]
pub struct Tap {
    /// Byte sequences scanned per untrusted party. One party cannot satisfy
    /// another party's non-vacuity requirement.
    pub per_party: std::collections::BTreeMap<Party, u64>,
    /// Parties the scenario exercises; each must see at least one scan.
    pub required_parties: std::collections::BTreeSet<Party>,
    /// Scans per path (`item:entry`, `object:chunk`, `ephemeral`, `error`, ...).
    pub per_path: std::collections::BTreeMap<String, u64>,
    /// Paths the scenario exercises: each must be scanned at least once.
    pub required: std::collections::BTreeSet<String>,
    /// Content markers (beyond tokens): (label, bytes).
    pub markers: Vec<(String, Vec<u8>)>,
    /// Secrets that no untrusted party may see: (label, bytes).
    pub secrets: Vec<(String, Vec<u8>)>,
    /// A log service takes part in this scenario: scanning nothing is a failure.
    pub expected: bool,
    /// Total byte sequences scanned across all parties.
    pub scanned: u64,
    /// Frames inflated while scanning.
    pub inflated: u64,
    /// Hits.
    pub hits: Vec<Hit>,
}

const MAX_RAW: usize = 16 << 20;

/// Every embedded `alg = 1` frame (`u8(1) ‖ u32be(len) ‖ u32be(raw_len) ‖ data`)
/// in `b` that inflates to exactly `raw_len` bytes.
pub fn inflate_frames(b: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let n = b.len();
    let mut i = 0;
    while i + 9 < n {
        if b[i] == 1 {
            let len = u32::from_be_bytes([b[i + 1], b[i + 2], b[i + 3], b[i + 4]]) as usize;
            let raw = u32::from_be_bytes([b[i + 5], b[i + 6], b[i + 7], b[i + 8]]) as usize;
            if len >= 2
                && i + 9 + len <= n
                && raw <= MAX_RAW
                && raw > 0
                && raw <= len.saturating_mul(1032)
                && let Ok(plain) =
                    miniz_oxide::inflate::decompress_to_vec_with_limit(&b[i + 9..i + 9 + len], raw)
                && plain.len() == raw
            {
                out.push(plain);
                i += 9 + len;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn hex(b: &[u8]) -> Vec<u8> {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = Vec::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize]);
        s.push(H[(x & 15) as usize]);
    }
    s
}

/// RFC 4648 base64 (`url`: the URL-safe alphabet).
pub fn base64(b: &[u8], url: bool, pad: bool) -> Vec<u8> {
    let a: &[u8; 64] = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = Vec::new();
    for c in b.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        let k = c.len() + 1;
        for i in 0..4 {
            if i < k {
                out.push(a[((n >> (18 - 6 * i)) & 63) as usize]);
            } else if pad {
                out.push(b'=');
            }
        }
    }
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

impl Tap {
    /// Register a content marker.
    pub fn marker(&mut self, label: &str, bytes: &[u8]) {
        self.markers.push((label.to_string(), bytes.to_vec()));
    }

    /// Register a secret, in every encoding it could travel in: raw bytes, hex
    /// (lower and upper), base64 and base64url (padded and unpadded), plus the
    /// neighbour-independent characters at every embedded base64 alignment.
    pub fn secret(&mut self, label: &str, bytes: &[u8]) {
        if self.secrets.iter().any(|(_, s)| s == bytes) {
            return;
        }
        self.secrets.push((label.to_string(), bytes.to_vec()));
        let h = hex(bytes);
        self.secrets.push((format!("{label} (hex)"), h.clone()));
        self.secrets
            .push((format!("{label} (HEX)"), h.to_ascii_uppercase()));
        for (name, url, pad) in [
            ("base64", false, true),
            ("base64 unpadded", false, false),
            ("base64url", true, true),
            ("base64url unpadded", true, false),
        ] {
            self.secrets
                .push((format!("{label} ({name})"), base64(bytes, url, pad)));
        }
        for url in [false, true] {
            for offset in 0..3usize {
                let mut prefixed = vec![0; offset];
                prefixed.extend_from_slice(bytes);
                let encoded = base64(&prefixed, url, false);
                // A character covers six bits. Keep only characters entirely
                // inside the secret: edge characters also depend on neighbours.
                let start = (offset * 8).div_ceil(6);
                let end = (prefixed.len() * 8) / 6;
                if start < end {
                    self.secrets.push((
                        format!("{label} (embedded base64 url={url} offset={offset})"),
                        encoded[start..end].to_vec(),
                    ));
                }
            }
        }
    }

    /// The scenario exercises `path`: it must be scanned at least once.
    pub fn require(&mut self, path: &str) {
        self.required.insert(path.to_string());
    }

    /// Required paths that were never scanned.
    pub fn unscanned(&self) -> Vec<String> {
        self.required
            .iter()
            .filter(|p| self.per_path.get(*p).copied().unwrap_or(0) == 0)
            .cloned()
            .collect()
    }

    /// Scan bytes on a named path (`item:entry`, `object:chunk`, ...).
    pub fn scan_path(&mut self, party: Party, path: &str, what: &str, b: &[u8]) {
        *self.per_path.entry(path.to_string()).or_default() += 1;
        self.scan(party, &format!("{path} {what}"), b);
    }

    /// Declare that this scenario exercises an untrusted party.
    pub fn require_party(&mut self, party: Party) {
        self.required_parties.insert(party);
    }

    /// Required parties that have received no scans. The legacy log-service
    /// expectation is checked against log scans, never the global scan total.
    pub fn unscanned_parties(&self) -> Vec<Party> {
        let mut required = self.required_parties.clone();
        if self.expected {
            required.insert(Party::LogService);
        }
        required
            .into_iter()
            .filter(|party| self.per_party.get(party).copied().unwrap_or(0) == 0)
            .collect()
    }

    fn plaintext_in(&self, b: &[u8]) -> Option<String> {
        if let Some(t) = tokens_in(b).first() {
            return Some(format!("token {t}"));
        }
        self.markers
            .iter()
            .find(|(_, m)| contains(b, m))
            .map(|(l, _)| format!("marker {l}"))
    }

    /// Scan bytes that `party` received or stores; `what` says what they are.
    pub fn scan(&mut self, party: Party, what: &str, b: &[u8]) {
        self.scanned += 1;
        *self.per_party.entry(party).or_default() += 1;
        let mut views = vec![b.to_vec()];
        for f in inflate_frames(b) {
            self.inflated += 1;
            views.push(f);
        }
        // Secrets are matched raw and in their encodings (registered alongside), so
        // only the raw and inflated views are needed here.
        for (k, v) in views.iter().enumerate() {
            let layer = if k == 0 { "" } else { " (inflated)" };
            if let Some(h) = self.plaintext_in(v) {
                self.hits.push(Hit {
                    kind: Kind::Plaintext,
                    detail: format!("{} received {what}{layer} carrying {h}", party.name()),
                });
                return;
            }
            if let Some((l, _)) = self.secrets.iter().find(|(_, s)| contains(v, s)) {
                self.hits.push(Hit {
                    kind: Kind::KeyExposure,
                    detail: format!(
                        "{} received {what}{layer} carrying secret {l}",
                        party.name()
                    ),
                });
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(plain: &[u8]) -> Vec<u8> {
        let data = miniz_oxide::deflate::compress_to_vec(plain, 6);
        let mut f = vec![1u8];
        f.extend_from_slice(&(data.len() as u32).to_be_bytes());
        f.extend_from_slice(&(plain.len() as u32).to_be_bytes());
        f.extend_from_slice(&data);
        f
    }

    #[test]
    fn all_private_parties_reject_plaintext_and_keys() {
        for party in [Party::HostedPrivate, Party::Relay, Party::ControlPlane] {
            let mut tap = Tap::default();
            tap.marker("field title", b"title:");
            tap.secret("device key", &[7; 32]);
            tap.scan(party, "ciphertext", &[9; 100]);
            assert!(tap.hits.is_empty());
            tap.scan(party, "raw", b"title: private");
            tap.scan(party, "compressed", &frame(b"tk000123x"));
            tap.scan(party, "key", &[7; 32]);
            assert_eq!(
                tap.hits.iter().map(|hit| hit.kind).collect::<Vec<_>>(),
                vec![Kind::Plaintext, Kind::Plaintext, Kind::KeyExposure]
            );
            assert!(
                tap.hits
                    .iter()
                    .all(|hit| hit.detail.starts_with(party.name()))
            );
            assert_eq!(tap.per_party[&party], 4);
        }
    }

    #[test]
    fn secrets_in_every_encoding() {
        assert_eq!(base64(b"foobar", false, true), b"Zm9vYmFy");
        assert_eq!(base64(b"fo", false, true), b"Zm8=");
        assert_eq!(base64(&[0xfb, 0xff], true, false), b"-_8");
        let key = [0xfbu8; 32];
        for enc in [
            key.to_vec(),
            hex(&key),
            hex(&key).to_ascii_uppercase(),
            base64(&key, false, true),
            base64(&key, true, false),
        ] {
            let mut t = Tap::default();
            t.secret("k", &key);
            let mut msg = b"{\"k\":\"".to_vec();
            msg.extend(enc);
            t.scan_path(Party::LogService, "error", "string", &msg);
            assert_eq!(t.hits.len(), 1);
            assert_eq!(t.per_path["error"], 1);
        }
        let mut t = Tap::default();
        t.require("item:rekey");
        assert_eq!(t.unscanned(), vec!["item:rekey".to_string()]);
    }

    #[test]
    fn secrets_embedded_in_base64_payloads() {
        // Different lengths cover every trailing bit alignment too. Prefixes
        // and suffixes are deliberately not zero (the registration padding).
        for len in 31..=33 {
            let key: Vec<u8> = (0..len).map(|i| (i * 17 + 251) as u8).collect();
            for offset in 0..3 {
                for neighbour in [0x01, 0x55, 0xff] {
                    let mut payload = vec![neighbour; 6 + offset];
                    payload.extend_from_slice(&key);
                    payload.extend_from_slice(&[neighbour; 5]);
                    for url in [false, true] {
                        for pad in [false, true] {
                            let encoded = base64(&payload, url, pad);
                            // Standalone encodings do not reliably match an
                            // embedded secret, even at offset zero (tail bits).
                            let mut tap = Tap::default();
                            tap.secret("device secret", &key);
                            tap.scan(Party::LogService, "encoded JSON", &encoded);
                            assert_eq!(
                                tap.hits.iter().map(|hit| hit.kind).collect::<Vec<_>>(),
                                vec![Kind::KeyExposure],
                                "len={len} offset={offset} neighbour={neighbour} url={url} pad={pad}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn scans_cannot_mask_another_partys_missing_coverage() {
        let mut tap = Tap {
            expected: true,
            ..Tap::default()
        };
        tap.require_party(Party::Relay);
        tap.require_party(Party::ControlPlane);
        tap.scan(Party::HostedPrivate, "unrelated", &[9; 100]);
        assert_eq!(
            tap.unscanned_parties(),
            vec![Party::LogService, Party::Relay, Party::ControlPlane]
        );
        tap.scan(Party::LogService, "frame", &[9; 100]);
        tap.scan(Party::Relay, "frame", &[9; 100]);
        assert_eq!(tap.unscanned_parties(), vec![Party::ControlPlane]);
        tap.scan(Party::ControlPlane, "frame", &[9; 100]);
        assert!(tap.unscanned_parties().is_empty());
    }

    #[test]
    fn embedded_patterns_do_not_match_unrelated_payloads() {
        let mut tap = Tap::default();
        tap.secret("epoch key", &[0xfb; 32]);
        for url in [false, true] {
            tap.scan(
                Party::LogService,
                "unrelated",
                &base64(&[0x55; 128], url, true),
            );
        }
        assert!(tap.hits.is_empty());
        let count = tap.secrets.len();
        tap.secret("same key", &[0xfb; 32]);
        assert_eq!(tap.secrets.len(), count);
    }

    #[test]
    fn party_and_path_coverage_remain_independent() {
        let mut tap = Tap {
            expected: true,
            ..Tap::default()
        };
        tap.require_party(Party::Relay);
        tap.require("object:chunk");
        tap.scan_path(Party::LogService, "object:chunk", "opaque", &[9; 100]);
        assert!(tap.unscanned().is_empty());
        assert_eq!(tap.unscanned_parties(), vec![Party::Relay]);
        tap.scan_path(Party::Relay, "ephemeral", "opaque", &[9; 100]);
        assert!(tap.unscanned_parties().is_empty());
        tap.require("item:rekey");
        assert_eq!(tap.unscanned(), vec!["item:rekey".to_string()]);
        assert_eq!(tap.per_path["object:chunk"], 1);
        assert_eq!(tap.per_path["ephemeral"], 1);
        assert_eq!(tap.per_party[&Party::LogService], 1);
        assert_eq!(tap.per_party[&Party::Relay], 1);
    }

    #[test]
    fn catches_raw_compressed_and_keys() {
        let mut t = Tap::default();
        t.marker("field title", b"title:");
        t.secret("epoch key 1", &[7u8; 32]);
        t.scan(Party::LogService, "opaque", &[9u8; 100]);
        assert!(t.hits.is_empty());
        t.scan(Party::LogService, "raw", b"---\ntitle: x\n");
        let mut wrapped = b"\x8a\x0bheader".to_vec();
        wrapped.extend(frame(b"---\nstatus: open\n- tk000055x\n"));
        t.scan(Party::LogService, "deflated", &wrapped);
        t.scan(Party::HostedPrivate, "store", &hex(&[7u8; 32]));
        let kinds: Vec<Kind> = t.hits.iter().map(|h| h.kind).collect();
        assert_eq!(
            kinds,
            vec![Kind::Plaintext, Kind::Plaintext, Kind::KeyExposure]
        );
        assert!(t.hits[1].detail.contains("inflated"));
        assert_eq!(t.scanned, 4);
    }
}
