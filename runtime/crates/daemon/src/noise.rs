//! Compatibility exports of the shared production Noise implementation.
//!
//! Native entropy stays daemon-side. Admission (device/grant/prologue policy)
//! remains the responsibility of each caller, not the crypto crate.

pub use mdbn_noise::*;
use zeroize::Zeroizing;

/// A fresh ephemeral secret from OS entropy.
pub fn ephemeral() -> Result<Zeroizing<[u8; 32]>, NoiseError> {
    let mut e = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut e[..]).map_err(|_| NoiseError::Limit)?;
    Ok(e)
}
