//! HOST ONLY consuming AK1 unlock of this existing app collection. Delegates
//! recovery derivation/self-grant/status to the production Replica gates; no
//! raw R/derived key export, new signer, policy shortcut or strict-mode fallback.
use super::{AppRuntime, wipe};
use mdbn_replica::{crypto::recovery::RecoveryKey, replica::AccountKeyRefusal};
use mdbn_wire::cbor::{self, Cbor};
fn status(state: Result<bool, AccountKeyRefusal>) -> Vec<u8> {
    let (code, reason) = match state {
        Ok(false) => (0, Cbor::Null),
        Ok(true) => (1, Cbor::Null),
        Err(reason) => (
            2,
            Cbor::Text(
                match reason {
                    AccountKeyRefusal::NotPrivate => "not_private",
                    AccountKeyRefusal::NotReady => "not_ready",
                    AccountKeyRefusal::NotEnrolled => "not_enrolled",
                    AccountKeyRefusal::NotAuthorized => "not_authorized",
                    AccountKeyRefusal::DeviceMissing => "device_missing",
                    AccountKeyRefusal::EnrolmentMismatch => "enrolment_mismatch",
                    AccountKeyRefusal::NotKeyed => "not_keyed",
                    AccountKeyRefusal::NoWrap => "no_wrap",
                    AccountKeyRefusal::Inconsistent => "inconsistent",
                    AccountKeyRefusal::Failed => "failed",
                    AccountKeyRefusal::OutcomeUnknown => "outcome_unknown",
                }
                .into(),
            ),
        ),
    };
    cbor::encode(&Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Uint(code)),
        (Cbor::Uint(1), reason),
    ]))
    .unwrap_or_default()
}
impl AppRuntime {
    /// HOST ONLY protected transient R32 loan, consumed/wiped on every path.
    /// Derives ONLY this native collection's recovery keys. Started/pending is
    /// NOT keyed: Replica verifies current signed policy/wrap/commit/read-ahead,
    /// uses its ordinary self-grant append/transaction and applied-policy gates.
    pub fn unlock_account_key_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        if bytes.len() != 32 || self.runtime.is_none() || !self.healthy() {
            wipe(bytes);
            return Vec::new();
        }
        let secret = RecoveryKey::from_bytes(<[u8; 32]>::try_from(&*bytes).expect("checked32"));
        let keys = secret.derive(&self.collection);
        drop(secret);
        wipe(bytes);
        let replica = self
            .runtime
            .as_mut()
            .expect("checked runtime")
            .replica_mut();
        match replica.self_grant_with_account_key(keys) {
            Ok(()) => status(replica.account_key_unlock_state()),
            Err(reason) => status(Err(reason)),
        }
    }
    /// HOST ONLY setup of the exact derived recovery device, AFTER the CP has
    /// actually enrolled it. Production Replica validates its full public tuple,
    /// current editor/key trust/rekey/store fences and uses ordinary KEY_GRANT.
    /// The result describes the RECOVERY DEVICE, never this app/Saved. No extra
    /// R/derived signer custody: keys are borrowed for this call then dropped.
    pub fn setup_account_key_device_consuming(&mut self, bytes: &mut [u8]) -> Vec<u8> {
        if bytes.len() != 32 || self.runtime.is_none() || !self.healthy() {
            wipe(bytes);
            return Vec::new();
        }
        let secret = RecoveryKey::from_bytes(<[u8; 32]>::try_from(&*bytes).expect("checked32"));
        let keys = secret.derive(&self.collection);
        drop(secret);
        wipe(bytes);
        let replica = self
            .runtime
            .as_mut()
            .expect("checked runtime")
            .replica_mut();
        match replica.key_account_key_device(&keys) {
            Ok(()) => status(replica.account_key_device_keyed(&keys)),
            Err(reason) => status(Err(reason)),
        }
    }
    /// Read-only actual applied-policy/trust result, no pending/head/keyring/Saved
    /// inference. A retired/absent native owner returns no status.
    pub fn account_key_state(&mut self) -> Vec<u8> {
        let Some(runtime) = self.runtime.as_mut() else {
            return Vec::new();
        };
        status(runtime.replica_mut().account_key_unlock_state())
    }
}
