//! The run trace and the determinism digest.
//!
//! Every decision the world makes is a trace line `t=<ms since start> <who> <what>`.
//! The **determinism digest** is a hash over every line in order, so two runs of
//! one seed agree on the digest iff they made identical decisions. A failing seed
//! replays exactly, and `--trace` / `--grep` show what happened (see `main.rs`).

/// FNV-1a 64: fast, specified, adequate for a run digest.
#[derive(Debug, Clone, Copy)]
pub struct Fnv(pub u64);

impl Default for Fnv {
    fn default() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
}

impl Fnv {
    /// Feed bytes.
    pub fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 ^= u64::from(x);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    /// Feed a length-prefixed string.
    pub fn str(&mut self, s: &str) {
        self.bytes(&(s.len() as u64).to_le_bytes());
        self.bytes(s.as_bytes());
    }
}

/// The trace of one run.
#[derive(Debug, Default)]
pub struct Trace {
    /// Keep lines in memory (off for large sweeps; the digest is always computed).
    pub keep: bool,
    /// Kept lines.
    pub lines: Vec<String>,
    /// Running digest over every line.
    pub digest: Fnv,
    /// Lines recorded.
    pub count: u64,
}

impl Trace {
    /// A trace that keeps lines iff `keep`.
    pub fn new(keep: bool) -> Self {
        Trace {
            keep,
            ..Default::default()
        }
    }

    /// Record a line at world time `elapsed_ms`.
    pub fn line(&mut self, elapsed_ms: u64, who: &str, what: &str) {
        let l = format!("t={elapsed_ms} {who} {what}");
        self.push(l);
    }

    /// Record a preformatted line.
    pub fn push(&mut self, l: String) {
        self.digest.str(&l);
        self.count += 1;
        if self.keep {
            self.lines.push(l);
        }
    }

    /// A detail line: kept only when tracing, and never part of the digest (so a
    /// traced replay has the same digest as an untraced run).
    pub fn detail(&mut self, l: String) {
        if self.keep {
            self.lines.push(l);
        }
    }

    /// Lines matching any `|`-separated pattern.
    pub fn grep<'a>(&'a self, pat: &'a str) -> impl Iterator<Item = &'a String> + 'a {
        self.lines
            .iter()
            .filter(move |l| pat.split('|').any(|p| !p.is_empty() && l.contains(p)))
    }
}
