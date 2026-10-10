//! Synthetic plaintext data fixtures, but REAL strict CP root/policy signatures.
//! The production public-before-custody verifier NEVER uses this test adapter.
use super::*;
use mdbn_replica::Sealer;
use mdbn_replica::crypto::{
    CsprngEntropy,
    keys::Recipient,
    sign::{DeviceSigner, Ed25519Verifier},
};
use mdbn_replica::policy::SigVerifier;
use mdbn_replica::seal::{KeyEvent, OpenError, SealError, ZeroVerifier};
use mdbn_replica::testkit::{SIGNED_CP_SEED, signed_root};
use mdbn_wire::envelope::{Item, KeyGrantPayload};
use zeroize::Zeroizing;

pub(super) struct ControlVerifier;
impl SigVerifier for ControlVerifier {
    fn verify(&self, pk: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> bool {
        if *pk == signed_root() || *pk == DeviceSigner::from_seed(&SIGNED_CP_SEED).public() {
            Ed25519Verifier.verify(pk, digest, sig)
        } else {
            // Existing fake device data/rekey tests keep their explicit zero
            // signatures; ZERO CP/root signatures are no longer accepted.
            ZeroVerifier.verify(pk, digest, sig)
        }
    }
}

pub(super) struct SignedControlPlain(PlainSealer);
impl SignedControlPlain {
    pub(super) fn for_device(device: B16) -> Self {
        Self(PlainSealer::for_device(device))
    }
}
impl Sealer for SignedControlPlain {
    fn set_epoch(&mut self, epoch: u64) {
        self.0.set_epoch(epoch);
    }
    fn current_epoch(&self) -> Option<u64> {
        self.0.current_epoch()
    }
    fn idem_token(&self, id: &B16) -> Option<B16> {
        self.0.idem_token(id)
    }
    fn seal(
        &mut self,
        i: &mut Item,
        p: &[u8],
        c: bool,
        e: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.0.seal(i, p, c, e)
    }
    fn seal_object(
        &mut self,
        i: &mut Item,
        p: &[u8],
        c: bool,
        s: bool,
        e: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.0.seal_object(i, p, c, s, e)
    }
    fn blob_part_addresses(&self, b: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
        self.0.blob_part_addresses(b)
    }
    fn sign(&self, i: &mut Item) -> Result<(), SealError> {
        self.0.sign(i)
    }
    fn open(&self, i: &Item, b: &[u8]) -> Result<Vec<u8>, OpenError> {
        self.0.open(i, b)
    }
    fn verifier(&self) -> &dyn SigVerifier {
        &ControlVerifier
    }
    fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent {
        self.0.accept_rekey(p)
    }
    fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent {
        self.0.accept_key_grant(p)
    }
    fn accept_key_grant_ahead(
        &mut self,
        g: &KeyGrantPayload,
        r: &RekeyPayload,
        want: u64,
    ) -> KeyEvent {
        self.0.accept_key_grant_ahead(g, r, want)
    }
    fn build_rekey(
        &mut self,
        f: u64,
        r: &[Recipient],
        reason: RekeyReason,
        e: &mut dyn CsprngEntropy,
    ) -> Result<RekeyPayload, SealError> {
        self.0.build_rekey(f, r, reason, e)
    }
    fn build_key_grant(
        &self,
        epoch: u64,
        r: &Recipient,
        e: &mut dyn CsprngEntropy,
    ) -> Result<KeyGrantPayload, SealError> {
        self.0.build_key_grant(epoch, r, e)
    }
    fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
        self.0.export()
    }
    fn import(&mut self, b: &[u8]) -> Result<(), SealError> {
        self.0.import(b)
    }
}
