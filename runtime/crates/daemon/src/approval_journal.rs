//! OS-keychain-only requester state persistence. This module stores opaque secret
//! state; it does not authenticate peers or decide approval semantics. The replica
//! controller must validate current custody/account incarnation before and after
//! I/O and include revealed state AND the selected verified approver in one blob.
//! One owning collection actor serializes access; this is not a multiwriter CAS.
use crate::secrets::SecretStore;
use std::sync::Arc;
use zeroize::Zeroizing;

const MAGIC: &[u8] = b"MDBASE-SAS-REQUESTER\x01";
const MAX_STATE: usize = 4096;

/// Content-free journal failures. A failed write/readback is NEVER rollback proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalError {
    /// Production requester state cannot use file or memory fallback.
    BackendDenied,
    /// Malformed identity binding or stored record.
    Invalid,
    /// Reading failed; reopen required.
    Unavailable,
    /// Write or readback failed; the outcome is uncertain, reopen required.
    OutcomeUnknown,
    /// This instance has already observed storage uncertainty.
    Poisoned,
}

/// Profile-scoped OS-secret journal. No raw-state Debug or plaintext index.
pub struct RequesterJournal {
    store: Arc<dyn SecretStore>,
    name: String,
    header: Vec<u8>,
    poisoned: bool,
}
impl std::fmt::Debug for RequesterJournal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RequesterJournal")
            .field("poisoned", &self.poisoned)
            .finish_non_exhaustive()
    }
}
impl RequesterJournal {
    /// Bind storage to collection, authenticated account, actual device and durable
    /// account incarnation. These values are STORAGE bindings, not authority; the
    /// owning controller must obtain them from its current trusted source.
    pub fn new(
        store: Arc<dyn SecretStore>,
        collection: [u8; 16],
        account: [u8; 16],
        device: [u8; 16],
        account_epoch: u64,
    ) -> Result<Self, JournalError> {
        if store.backend() != "keychain" {
            return Err(JournalError::BackendDenied);
        }
        if [collection, account, device].contains(&[0; 16]) || account_epoch == 0 {
            return Err(JournalError::Invalid);
        }
        let mut header = MAGIC.to_vec();
        for id in [collection, account, device] {
            header.extend_from_slice(&id);
        }
        header.extend_from_slice(&account_epoch.to_be_bytes());
        let name = format!(
            "approval-requester:{}",
            crate::secrets::hex(&mdbn_wire::hash::sha256(&header).0)
        );
        Ok(Self {
            store,
            name,
            header,
            poisoned: false,
        })
    }
    /// Restore opaque requester state. A missing record requires a FRESH commitment,
    /// never reconstruction/reuse of a previously revealed commitment.
    pub fn load(&mut self) -> Result<Option<Zeroizing<Vec<u8>>>, JournalError> {
        if self.poisoned {
            return Err(JournalError::Poisoned);
        }
        let record = match self.store.get(&self.name) {
            Ok(v) => v,
            Err(_) => {
                self.poisoned = true;
                return Err(JournalError::Unavailable);
            }
        };
        let Some(record) = record else {
            return Ok(None);
        };
        let h = self.header.len();
        if record.len() <= h || record.len() > h + MAX_STATE || !record.starts_with(&self.header) {
            self.poisoned = true;
            return Err(JournalError::Invalid);
        }
        Ok(Some(Zeroizing::new(record[h..].to_vec())))
    }
    /// Restore the enrolment commitment after an unknown join outcome. Only a
    /// missing record creates a requester; corrupt, unavailable or revealed state
    /// never resets the exchange. The caller supplies its current trusted tuple.
    pub fn join_commitment(
        &mut self,
        collection: mdbn_wire::common::Uuid,
        me: mdbn_replica::crypto::keys::EnrolledKeys,
        entropy: &mut dyn mdbn_replica::crypto::CsprngEntropy,
    ) -> Result<[u8; 32], JournalError> {
        use mdbn_replica::approval::NewDevice;
        let requester = match self.load()? {
            Some(state) => {
                NewDevice::restore(collection, me, &state).map_err(|_| JournalError::Invalid)?
            }
            None => {
                let requester = NewDevice::new(collection, me, entropy);
                self.save(&requester.state())?;
                requester
            }
        };
        if requester.approver().is_some() {
            return Err(JournalError::Invalid);
        }
        Ok(requester.commitment())
    }
    /// Persist the WHOLE secret controller state before returning any code/reveal.
    /// Successful readback is logical verification, not physical powercut evidence.
    /// On uncertainty emit nothing and dispose/reopen the owning controller.
    pub fn save(&mut self, state: &[u8]) -> Result<(), JournalError> {
        if self.poisoned {
            return Err(JournalError::Poisoned);
        }
        if state.is_empty() || state.len() > MAX_STATE {
            return Err(JournalError::Invalid);
        }
        let mut record = Zeroizing::new(self.header.clone());
        record.extend_from_slice(state);
        let written = self.store.set(&self.name, &record);
        let verified = if written.is_ok() {
            self.store.get(&self.name)
        } else {
            self.poisoned = true;
            return Err(JournalError::OutcomeUnknown);
        };
        if !matches!(verified,Ok(Some(ref v)) if v.as_slice()==record.as_slice()) {
            self.poisoned = true;
            return Err(JournalError::OutcomeUnknown);
        }
        Ok(())
    }
}

impl mdbn_replica::replica::ApprovalSecretJournal for RequesterJournal {
    fn load(
        &mut self,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, mdbn_replica::replica::ApprovalPersistenceError> {
        RequesterJournal::load(self).map_err(|_| mdbn_replica::replica::ApprovalPersistenceError)
    }
    fn save(
        &mut self,
        state: &[u8],
    ) -> Result<(), mdbn_replica::replica::ApprovalPersistenceError> {
        RequesterJournal::save(self, state)
            .map_err(|_| mdbn_replica::replica::ApprovalPersistenceError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::{MemoryStore, SecretError};
    use std::sync::atomic::{AtomicBool, Ordering};
    // Synthetic provider only: tests do NOT claim OS custody or durability.
    #[derive(Default)]
    struct FakeKeychain {
        memory: MemoryStore,
        fail_after: AtomicBool,
        bad_read: AtomicBool,
    }
    impl SecretStore for FakeKeychain {
        fn backend(&self) -> &'static str {
            "keychain"
        }
        fn get(&self, n: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
            if self.bad_read.load(Ordering::SeqCst) {
                return Ok(Some(Zeroizing::new(vec![0])));
            }
            self.memory.get(n)
        }
        fn set(&self, n: &str, v: &[u8]) -> Result<(), SecretError> {
            self.memory.set(n, v)?;
            if self.fail_after.load(Ordering::SeqCst) {
                return Err(SecretError::Unavailable("synthetic uncertain write".into()));
            }
            Ok(())
        }
        fn delete(&self, n: &str) -> Result<(), SecretError> {
            self.memory.delete(n)
        }
    }
    fn journal(s: Arc<FakeKeychain>, epoch: u64) -> RequesterJournal {
        RequesterJournal::new(s, [1; 16], [2; 16], [3; 16], epoch).unwrap()
    }
    #[test]
    fn requester_journal_restores_whole_state_and_separates_incarnations() {
        let s = Arc::new(FakeKeychain::default());
        let mut j = journal(s.clone(), 7);
        j.save(b"PUBLIC SYNTHETIC REVEALED+SELECTED-PEER").unwrap();
        assert_eq!(
            journal(s.clone(), 7).load().unwrap().unwrap().as_slice(),
            b"PUBLIC SYNTHETIC REVEALED+SELECTED-PEER"
        );
        assert!(journal(s, 8).load().unwrap().is_none());
    }
    #[test]
    fn requester_journal_unknown_write_is_not_rollback() {
        let s = Arc::new(FakeKeychain::default());
        s.fail_after.store(true, Ordering::SeqCst);
        let mut j = journal(s.clone(), 7);
        assert_eq!(
            j.save(b"PUBLIC SYNTHETIC STATE"),
            Err(JournalError::OutcomeUnknown)
        );
        assert_eq!(j.load(), Err(JournalError::Poisoned));
        assert_eq!(j.save(b"replacement"), Err(JournalError::Poisoned));
        assert_eq!(
            journal(s, 7).load().unwrap().unwrap().as_slice(),
            b"PUBLIC SYNTHETIC STATE"
        );
    }
    #[test]
    fn requester_journal_bad_readback_and_binding_deny() {
        let s = Arc::new(FakeKeychain::default());
        s.bad_read.store(true, Ordering::SeqCst);
        let mut j = journal(s.clone(), 7);
        assert_eq!(j.save(b"PUBLIC STATE"), Err(JournalError::OutcomeUnknown));
        assert_eq!(journal(s, 7).load(), Err(JournalError::Invalid));
    }
    fn keys() -> mdbn_replica::crypto::keys::EnrolledKeys {
        mdbn_replica::crypto::keys::EnrolledKeys {
            device: mdbn_wire::common::B16([3; 16]),
            sign_pk: [4; 32],
            kem_pk: [5; 32],
            noise_pk: [6; 32],
        }
    }
    struct TestEntropy;
    impl mdbn_core::host::Entropy for TestEntropy {
        fn fill(&mut self, buf: &mut [u8]) {
            getrandom::fill(buf).unwrap();
        }
    }
    impl mdbn_replica::crypto::CsprngEntropy for TestEntropy {}
    fn join(j: &mut RequesterJournal) -> Result<[u8; 32], JournalError> {
        j.join_commitment(mdbn_wire::common::B16([1; 16]), keys(), &mut TestEntropy)
    }
    #[test]
    fn join_retry_and_restart_reuse_the_persisted_enrolment() {
        let s = Arc::new(FakeKeychain::default());
        let mut first = journal(s.clone(), 7);
        let commit = join(&mut first).unwrap();
        let saved = first.load().unwrap().unwrap();
        // A response lost AFTER enrolment must not cause a replacement write.
        assert_eq!(join(&mut first), Ok(commit));
        let mut reopened = journal(s.clone(), 7);
        assert_eq!(join(&mut reopened), Ok(commit));
        assert_eq!(reopened.load().unwrap().unwrap(), saved);
        s.fail_after.store(true, Ordering::SeqCst);
        assert_eq!(join(&mut reopened), Ok(commit));
        assert!(journal(s, 8).load().unwrap().is_none());
    }
    #[test]
    fn join_never_replaces_corrupt_or_uncertain_state() {
        let s = Arc::new(FakeKeychain::default());
        let mut j = journal(s.clone(), 7);
        j.save(b"corrupt requester state").unwrap();
        assert_eq!(join(&mut j), Err(JournalError::Invalid));
        assert_eq!(
            j.load().unwrap().unwrap().as_slice(),
            b"corrupt requester state"
        );
        let s = Arc::new(FakeKeychain::default());
        s.fail_after.store(true, Ordering::SeqCst);
        let mut j = journal(s.clone(), 7);
        assert_eq!(join(&mut j), Err(JournalError::OutcomeUnknown));
        assert_eq!(join(&mut j), Err(JournalError::Poisoned));
        s.fail_after.store(false, Ordering::SeqCst);
        let stored = journal(s.clone(), 7).load().unwrap().unwrap();
        let expected = mdbn_replica::approval::NewDevice::restore(
            mdbn_wire::common::B16([1; 16]),
            keys(),
            &stored,
        )
        .unwrap()
        .commitment();
        assert_eq!(join(&mut journal(s, 7)), Ok(expected));
    }
    #[test]
    fn requester_journal_rejects_fallback_limits_and_redacts_debug() {
        assert!(matches!(
            RequesterJournal::new(
                Arc::new(MemoryStore::default()),
                [1; 16],
                [2; 16],
                [3; 16],
                7
            ),
            Err(JournalError::BackendDenied)
        ));
        let mut j = journal(Arc::new(FakeKeychain::default()), 7);
        assert_eq!(j.save(&vec![1; 4097]), Err(JournalError::Invalid));
        assert_eq!(j.save(&[]), Err(JournalError::Invalid));
        assert!(format!("{j:?}").contains("poisoned"));
        assert!(!format!("{j:?}").contains("approval-requester:"));
    }
}
