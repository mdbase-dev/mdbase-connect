//! One retained native observation across CPP awaits; sequencing DATA, no lease.
use crate::runtime::{CppClaimSignRefused, Engine, ObservedNativeTarget};
use mdbn_replica::Store;
use mdbn_wire::common::{B32, B64, Uuid};

pub(crate) struct CppClaimTicketSlot {
    id: u64,
    observed: ObservedNativeTarget,
    signed: bool,
}
impl CppClaimTicketSlot {
    pub(crate) fn begin<S: Store>(
        engine: &mut Engine<S>,
        id: u64,
    ) -> Result<Self, CppClaimSignRefused> {
        if id == 0 || id > (1_u64 << 53) - 1 {
            return Err(CppClaimSignRefused);
        }
        Ok(Self {
            id,
            observed: engine.observe_cpp_claim_target()?,
            signed: false,
        })
    }
    pub(crate) fn subject(&self) -> (u64, Uuid, Uuid) {
        (
            self.id,
            self.observed.admission().collection(),
            self.observed.admission().device(),
        )
    }
    /// Bind source DATA to the actual accepted native owner/target. A successful
    /// native signature attempt is necessary, not evidence of a CPP response.
    /// Only the closed owned-Control host exchange supplies the response facts.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn migration_binding<S: Store>(
        &self,
        engine: &mut Engine<S>,
        id: u64,
        owner: Uuid,
        started_us: String,
        target: (Uuid, B32, B32, B32),
    ) -> Result<crate::migration_action_ledger::RunBinding, CppClaimSignRefused> {
        self.assert_current(engine, id)?;
        let native = self.observed.admission();
        if !self.signed
            || owner != self.observed.genesis_owner()
            || target.0 != native.root_id()
            || target.1 != native.identity().sign_pk
            || target.2 != native.identity().kem_pk
            || target.3 != native.noise_pk()
        {
            return Err(CppClaimSignRefused);
        }
        let mut originals = Vec::with_capacity(96);
        for (_, raw) in self.observed.originals() {
            originals
                .extend_from_slice(&mdbn_wire::hash::h("mdbase/v1/native-run-original", raw).0);
        }
        Ok(crate::migration_action_ledger::RunBinding {
            collection: self.observed.admission().collection(),
            owner,
            started_us,
            target: mdbn_wire::hash::h("mdbase/v1/native-run-target", &originals),
        })
    }
    pub(crate) fn matches(&self, id: u64) -> bool {
        self.id == id
    }
    pub(crate) fn assert_current<S: Store>(
        &self,
        engine: &mut Engine<S>,
        id: u64,
    ) -> Result<(), CppClaimSignRefused> {
        if self.id != id {
            return Err(CppClaimSignRefused);
        }
        engine
            .recheck_native_target(&self.observed)
            .map_err(|_| CppClaimSignRefused)
    }
    pub(crate) fn sign<S: Store>(
        &mut self,
        engine: &mut Engine<S>,
        id: u64,
        challenge: B32,
    ) -> Result<B64, CppClaimSignRefused> {
        if self.id != id || self.signed {
            return Err(CppClaimSignRefused);
        }
        self.signed = true; // No retries/renewal, including refused signing attempts.
        engine.sign_cpp_claim_challenge(&self.observed, challenge)
    }
}

/// ABI numbers are exact positive integers, never truncations/NaN/aliases.
pub(crate) fn handle(value: f64) -> Option<u64> {
    if !value.is_finite()
        || value < 1.0
        || value > ((1_u64 << 53) - 1) as f64
        || value.fract() != 0.0
    {
        None
    } else {
        Some(value as u64)
    }
}
