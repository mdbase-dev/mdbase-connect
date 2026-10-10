//! Pure CollectionSetup components. The configuration algebra is ported first;
//! full envelope assessment, durable contributor locks and replica atomic apply
//! follow before exposing setup installation to applications.

pub mod capture;
pub mod configuration;
pub mod envelope;
pub mod receipts;
#[doc(hidden)]
pub mod witness;
