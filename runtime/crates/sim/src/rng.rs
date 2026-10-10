//! Seeded randomness.
//!
//! Every random choice in a world comes from a [`SimRng`] derived from the seed.
//! Actors get their own stream with [`SimRng::fork`], so adding a draw in one actor
//! never shifts the choices of another: a seed keeps meaning roughly the same
//! scenario as the simulator grows.
//!
//! Probabilities are integers in parts per million ([`Ppm`]), so no floating point
//! enters a decision.

/// A probability in parts per million (`1_000_000` = always).
pub type Ppm = u32;

/// One in a million.
pub const PPM: u32 = 1_000_000;

/// SplitMix64: small and fully specified, so a seed means the same thing on every
/// platform and toolchain.
#[derive(Debug, Clone)]
pub struct SimRng(u64);

impl SimRng {
    /// A generator for `seed`.
    pub fn new(seed: u64) -> Self {
        SimRng(seed)
    }

    /// An independent stream for `label`, derived from this generator's current
    /// state without advancing it.
    pub fn fork(&self, label: &str) -> SimRng {
        let mut h = 0xcbf2_9ce4_8422_2325u64 ^ self.0;
        for b in label.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        let mut r = SimRng(h);
        r.next_u64();
        r
    }

    /// The next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A value in `0..n`; 0 when `n == 0`.
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next_u64() % n }
    }

    /// A value in `lo..=hi`.
    pub fn between(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            lo
        } else {
            lo + self.below(hi - lo + 1)
        }
    }

    /// True with probability `p`.
    pub fn chance(&mut self, p: Ppm) -> bool {
        p > 0 && (p >= PPM || self.below(u64::from(PPM)) < u64::from(p))
    }

    /// A delay around `mean`: uniform in `[mean/2, 3*mean/2]`, at least 1.
    pub fn around(&mut self, mean: u64) -> u64 {
        (mean / 2 + self.below(mean + 1)).max(1)
    }

    /// A heavy-tailed delay with the given mean: mostly short, sometimes up to 8x.
    /// Used for inter-arrival times where bursts matter (editor saves, crashes).
    pub fn bursty(&mut self, mean: u64) -> u64 {
        let k = match self.below(16) {
            0..=7 => 1,  // 50%: ~0.25x..1x
            8..=12 => 4, // ~31%: up to 2x
            13..=14 => 8,
            _ => 16,
        };
        (self.below(mean.saturating_mul(k) / 4 + 1)).max(1)
    }

    /// A log-uniform delay in `[1, max_ms]`: as many stalls of 1–10 ms as of
    /// 10–100 ms, 100 ms–1 s and 1–10 s. How a descheduled process looks on an
    /// overloaded host: mostly short, sometimes seconds.
    pub fn log_uniform(&mut self, max_ms: u64) -> u64 {
        let max = max_ms.max(1);
        let mut decades = Vec::new();
        let mut lo = 1u64;
        while lo < max {
            decades.push((lo, (lo * 10).min(max)));
            lo *= 10;
        }
        if decades.is_empty() {
            return 1;
        }
        let (a, b) = decades[self.index(decades.len())];
        self.between(a, b)
    }

    /// Pick an index into a slice of length `n` (`n > 0`).
    pub fn index(&mut self, n: usize) -> usize {
        self.below(n as u64) as usize
    }

    /// Pick by integer weights; returns the index. All-zero weights pick 0.
    pub fn weighted(&mut self, weights: &[u32]) -> usize {
        let total: u64 = weights.iter().map(|w| u64::from(*w)).sum();
        let mut x = self.below(total);
        for (i, w) in weights.iter().enumerate() {
            let w = u64::from(*w);
            if x < w {
                return i;
            }
            x -= w;
        }
        0
    }
}

/// Seeded, **non-cryptographic** bytes for the code under test, so a seed
/// reproduces a run.
///
/// `SimRng` itself deliberately does not implement `Entropy`: the only way to
/// hand deterministic bytes to a replica is this loudly named wrapper, which
/// exists only in `mdbn-sim`. No shipped crate may depend on `mdbn-sim`
/// (`cargo xtask arch`, `TEST_ONLY`). When core adds the `CsprngEntropy` marker
/// (requested in the simulator entropy contract), this is
/// the simulator's single implementation of it.
#[derive(Debug, Clone)]
pub struct SeededTestEntropy(SimRng);

impl SeededTestEntropy {
    /// Deterministic test entropy derived from a world stream.
    pub fn from_world(rng: &SimRng, label: &str) -> Self {
        SeededTestEntropy(rng.fork(&format!("entropy/{label}")))
    }
}

/// The simulator's single implementation of the marker: seeded bytes are
/// reachable only from `mdbn-sim`, which no shipped crate may depend on.
impl mdbn_replica::crypto::CsprngEntropy for SeededTestEntropy {}

impl mdbn_core::host::Entropy for SeededTestEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        for chunk in buf.chunks_mut(8) {
            let b = self.0.next_u64().to_le_bytes();
            chunk.copy_from_slice(&b[..chunk.len()]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forks_are_independent_and_stable() {
        let root = SimRng::new(42);
        let mut a1 = root.fork("a");
        let mut a2 = root.fork("a");
        let mut b = root.fork("b");
        assert_eq!(a1.next_u64(), a2.next_u64());
        assert_ne!(a1.next_u64(), b.next_u64());
    }

    #[test]
    fn chance_bounds() {
        let mut r = SimRng::new(1);
        assert!(!(0..1000).any(|_| r.chance(0)));
        assert!((0..1000).all(|_| r.chance(PPM)));
        let hits = (0..100_000).filter(|_| r.chance(250_000)).count();
        assert!((23_000..27_000).contains(&hits), "{hits}");
    }
}
