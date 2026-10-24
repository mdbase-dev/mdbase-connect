//! Injected host capabilities.
//!
//! Portable crates never read the clock or OS entropy themselves. A host (the
//! desktop daemon, the Obsidian runtime, the hosted replica, the simulator) passes
//! implementations of these traits in. The simulator supplies deterministic ones,
//! which is what makes a seed reproducible.
//!
//! These are stubs: the contracts in `docs/contracts/` define the final shapes.

/// Wall-clock time, as the host sees it.
pub trait Clock {
    /// Milliseconds since the Unix epoch. Need not be monotonic across calls.
    fn now_ms(&self) -> u64;
}

/// Cryptographically secure randomness from the host.
///
/// Nonces and key material must come from here, seeding a CSPRNG if needed, and
/// never from a configured seed (injected entropy).
pub trait Entropy {
    /// Fill `buf` with random bytes.
    fn fill(&mut self, buf: &mut [u8]);
}

/// A clock that always reports the same instant. For tests and fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedClock(pub u64);

impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
}
