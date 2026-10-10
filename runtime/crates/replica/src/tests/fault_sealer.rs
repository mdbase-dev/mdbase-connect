//! Opaque-sealer fault boundaries, without assuming an export-less adapter is stateless.

use std::cell::Cell;
use std::rc::Rc;

use mdbn_wire::common::{B16, B32, Uuid};
use mdbn_wire::envelope::{Item, KeyGrantPayload, RekeyPayload, RekeyReason};
use zeroize::Zeroizing;

use crate::crypto::{CsprngEntropy, keys::Recipient};
use crate::policy::SigVerifier;
use crate::seal::{KeyEvent, OpenError, SealError, Sealer};

pub(super) struct FaultSealer {
    pub(super) inner: Box<dyn Sealer>,
    pub(super) no_export: Rc<Cell<bool>>,
    pub(super) fail_import: Rc<Cell<bool>>,
}

impl Sealer for FaultSealer {
    fn set_epoch(&mut self, epoch: u64) {
        self.inner.set_epoch(epoch);
    }
    fn current_epoch(&self) -> Option<u64> {
        self.inner.current_epoch()
    }
    fn idem_token(&self, mutation: &Uuid) -> Option<B16> {
        self.inner.idem_token(mutation)
    }
    fn seal(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.inner.seal(item, plain, compress, entropy)
    }
    fn seal_object(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        sign: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        self.inner.seal_object(item, plain, compress, sign, entropy)
    }
    fn blob_part_addresses(&self, blob: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
        self.inner.blob_part_addresses(blob)
    }
    fn sign(&self, item: &mut Item) -> Result<(), SealError> {
        self.inner.sign(item)
    }
    fn open(&self, item: &Item, raw: &[u8]) -> Result<Vec<u8>, OpenError> {
        self.inner.open(item, raw)
    }
    fn verifier(&self) -> &dyn SigVerifier {
        self.inner.verifier()
    }
    fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent {
        self.inner.accept_rekey(p)
    }
    fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent {
        self.inner.accept_key_grant(p)
    }
    fn build_rekey(
        &mut self,
        from: u64,
        recipients: &[Recipient],
        reason: RekeyReason,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<RekeyPayload, SealError> {
        self.inner.build_rekey(from, recipients, reason, entropy)
    }
    fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
        if self.no_export.get() {
            None
        } else {
            self.inner.export()
        }
    }
    fn import(&mut self, bytes: &[u8]) -> Result<(), SealError> {
        if self.fail_import.get() {
            Err(SealError::Failed("injected opaque import failure".into()))
        } else {
            self.inner.import(bytes)
        }
    }
}
