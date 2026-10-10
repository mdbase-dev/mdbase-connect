//! The seam to the keyring and crypto layer: sealing, opening, signing, epoch keys
//! and idempotency tokens for log items (`sealed-envelope.md`, `log-entry.md` §7).
//!
//! The append loop and apply call only this trait. [`KeyringSealer`] is the
//! production implementation over [`crate::crypto`]: epoch keys learned from
//! `rekey`/`key_grant` items (checked against their commitments), age-v1
//! STREAM sealing, Ed25519 `verify_strict`. [`PlainSealer`] is **test-only** (no
//! cryptography) and compiled only under `cfg(test)` or the `testing` feature.
//!
//! Policy (who may sign what, and when a key is current) is not decided here: the
//! replica applies [`crate::policy::PolicyState`] and tells the sealer the epoch in
//! force with [`Sealer::set_epoch`].

use std::collections::BTreeMap;

use mdbn_wire::common::{B16, B32, Signature, Uuid};
use mdbn_wire::envelope::{Item, KeyGrantPayload, RekeyPayload, RekeyReason};
use zeroize::{Zeroize, Zeroizing};

use crate::crypto::chunked_blob::upload_resume::{
    self, AuthenticatedUploadResumeV1, UploadResumeMetadataV1, UploadResumeOwnerV1,
    UploadResumeRefV1,
};
use crate::crypto::chunked_blob::{
    self, AttachmentLimits, AttachmentRefV1, ChunkContextV1, ChunkRefV1, ExpectedFileV1,
    ManifestV1, SealedChunkSpan, SealedObject, VerifiedManifestV1,
};
use crate::crypto::keys::{self, Keyring, Recipient, RekeyOpened};
use crate::crypto::sign::{DeviceSigner, Ed25519Verifier};
use crate::crypto::{CryptoError, CsprngEntropy, Secret32, hpke::KemKeyPair};
use crate::policy::SigVerifier;

/// Maximum UTF-8 token bytes accepted for a context-fixed log hello proof.
pub const MAX_LOG_TOKEN_BYTES: usize = 16 * 1024;

#[cfg(test)]
mod record_source_tests;

#[cfg(test)]
#[path = "seal_borrowed_tests.rs"]
mod borrowed_tests;

#[cfg(test)]
#[path = "seal_charged_tests.rs"]
mod charged_tests;

/// Why an item could not be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError {
    /// No key for the item's epoch yet: a stall (`waiting_for_key`), not a void.
    NoKey,
    /// The AEAD failed under a known key: void (V3).
    Aead,
}

/// Why an item could not be sealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// This replica holds no current epoch key (not keyed yet, or rekey pending).
    NotKeyed,
    /// Encoding or crypto failure.
    Failed(String),
}

impl From<CryptoError> for SealError {
    fn from(e: CryptoError) -> SealError {
        SealError::Failed(e.to_string())
    }
}

/// What a key item did for this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    /// Nothing for this device.
    None,
    /// This device now holds the key of `epoch`.
    Keyed {
        /// Epoch.
        epoch: u64,
    },
    /// The key sent to this device does not match its epoch's commitment
    /// (`key_inconsistent`). It is not used.
    Inconsistent,
}

/// Public identity of the cryptographic key custody behind a sealer.
/// No private key or epoch key is exposed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SealerIdentity {
    /// Collection whose epoch keys this sealer holds.
    pub collection: Uuid,
    /// Serving device.
    pub device: Uuid,
    /// Signing public key derived from the held private key.
    pub sign_pk: B32,
    /// KEM public key derived from the held private key.
    pub kem_pk: B32,
}

/// Keyring and crypto operations on log items.
pub trait Sealer {
    /// Independent public identity of production cryptographic custody. Default
    /// None: test/plain or opaque implementations cannot establish hosted admission.
    /// Implementations returning Some must verify signatures and key commitments;
    /// this is a trusted host implementation seam, not remotely supplied metadata.
    fn public_identity(&self) -> Option<SealerIdentity> {
        None
    }
    /// The epoch in force at the head, per policy.
    fn set_epoch(&mut self, epoch: u64);
    /// The epoch the writer seals under, if this device holds its key.
    fn current_epoch(&self) -> Option<u64>;
    /// The idempotency token for a mutation ID (`log-entry.md` §7).
    fn idem_token(&self, mutation: &Uuid) -> Option<B16>;
    /// Seal `plain` into `item` under the current epoch: sets `epoch`, `salt` and
    /// `body` (the AEAD binds the rest of the header), then signs. `compress` is false
    /// for entries in `e2e` collections and for entries with `on_behalf`.
    fn seal(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError>;
    /// Seal a stored object (`manifest` or `chunk`): sets `epoch`, `salt`, `body`,
    /// and `sig` when `sign` (manifests are signed, chunks are not).
    fn seal_object(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        sign: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError>;
    /// Seal a bounded record/reverse source using the existing Blob profile.
    /// CURRENT held epoch only, no compression, no signature or publication
    /// authority. The implementation must enforce the <=1 MiB plaintext cap.
    /// Unsupported custody implementations refuse without exposing epoch keys.
    fn seal_bounded_record_source(
        &self,
        _plain: &[u8],
        _entropy: &mut dyn CsprngEntropy,
    ) -> Result<
        (
            mdbn_wire::intent::BlobRef,
            Vec<crate::crypto::blob::SealedPart>,
        ),
        SealError,
    > {
        Err(SealError::Failed(
            "bounded record source unsupported".into(),
        ))
    }
    /// Explicit attachment-v1 writer; unsupported sealers fail closed.
    fn seal_attachment_chunk(
        &self,
        _context: &ChunkContextV1,
        _plain: &[u8],
        _entropy: &mut dyn CsprngEntropy,
    ) -> Result<(SealedObject, ChunkRefV1), SealError> {
        Err(SealError::Failed("attachment-v1 unsupported".into()))
    }
    /// Non-cached eligibility check BEFORE digest/plaintext work or entropy.
    /// Never a continuing permit: the actual sealing call repeats this check.
    /// Unsupported custody fails closed, without an owned/copy fallback.
    fn attachment_chunk_in_place_check(
        &self,
        _context: &ChunkContextV1,
        _plain_bytes: usize,
        _region_bytes: usize,
    ) -> Result<(), SealError> {
        Err(SealError::Failed(
            "in-place attachment writer unsupported".into(),
        ))
    }
    /// Seal only under the CURRENT held epoch, into the caller's private region.
    /// Errors must wipe the ENTIRE region. Returns only an exact sealed span;
    /// never export keys or copy through the owned writer as a fallback.
    fn seal_attachment_chunk_in_place(
        &self,
        _context: &ChunkContextV1,
        region: &mut [u8],
        _plain_bytes: usize,
        _entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedChunkSpan, SealError> {
        region.zeroize();
        Err(SealError::Failed(
            "in-place attachment writer unsupported".into(),
        ))
    }
    /// Server-only purpose-separated encrypted resume journal under CURRENT
    /// held epoch. Native owner/policy checks and confirmed staged commits are
    /// the caller's responsibility; custody is NOT a durable-progress permit.
    /// Unsupported sealers refuse without falling back to a legacy Blob.
    fn seal_hosted_upload_resume(
        &self,
        _metadata: &UploadResumeMetadataV1,
        _entropy: &mut dyn CsprngEntropy,
    ) -> Result<(SealedObject, UploadResumeRefV1), SealError> {
        Err(SealError::Failed("hosted upload resume unsupported".into()))
    }
    /// Authenticate encrypted R2 journal for the CURRENT session-derived owner.
    /// No historical-key resume. Always wipe ENTIRE supplied region, including
    /// success; parsed metadata stays native and never crosses the SQL/JS ABI.
    fn open_hosted_upload_resume(
        &self,
        _reference: &UploadResumeRefV1,
        _owner: UploadResumeOwnerV1,
        region: &mut [u8],
    ) -> Result<AuthenticatedUploadResumeV1, OpenError> {
        region.zeroize();
        Err(OpenError::Aead)
    }
    /// Reopen only a committed chunk from authenticated resume metadata, solely
    /// to rebuild native digest state. No VerifiedManifest shortcut, grant/key
    /// export, historical resume or continuing authority; full wipe on errors.
    fn open_hosted_upload_committed_chunk_in_place(
        &self,
        _resume: &AuthenticatedUploadResumeV1,
        _index: u64,
        region: &mut [u8],
    ) -> Result<std::ops::Range<usize>, OpenError> {
        region.zeroize();
        Err(OpenError::Aead)
    }
    /// Explicit attachment-v1 manifest writer under the CURRENT held epoch.
    fn seal_attachment_manifest(
        &self,
        _manifest: &ManifestV1,
        _limits: AttachmentLimits,
        _entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedObject, SealError> {
        Err(SealError::Failed("attachment-v1 unsupported".into()))
    }
    /// Read historical held epochs only under a descriptor from a verified
    /// critical wrapper, including its REQUIRED signed file size/hash.
    fn open_attachment_manifest(
        &self,
        _descriptor: &AttachmentRefV1,
        _expected: ExpectedFileV1,
        _raw: &[u8],
        _limits: AttachmentLimits,
    ) -> Result<VerifiedManifestV1, OpenError> {
        Err(OpenError::Aead)
    }
    /// Chunk reads require the authenticated manifest; never raw caller context.
    fn open_attachment_chunk(
        &self,
        _manifest: &VerifiedManifestV1,
        _index: u64,
        _raw: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, OpenError> {
        Err(OpenError::Aead)
    }
    /// Authenticate into a fixed caller-owned private region, without a body
    /// allocation. Unsupported sealers wipe and refuse, never copy as fallback.
    fn open_attachment_chunk_in_place(
        &self,
        _manifest: &VerifiedManifestV1,
        _index: u64,
        raw: &mut [u8],
    ) -> Result<std::ops::Range<usize>, OpenError> {
        raw.zeroize();
        Err(OpenError::Aead)
    }
    /// Authenticate one legacy Blob part under a descriptor from a verified
    /// wrapper. This bounded read exposes no keys, uses the descriptor epoch,
    /// and grants no holder/publication authority. The limit is PER-PART,
    /// at most 16 MiB, not a whole-file limit; streaming callers bound and verify
    /// the whole file separately. Unsupported sealers refuse.
    fn open_blob_part(
        &self,
        _descriptor: &mdbn_wire::intent::BlobRef,
        _index: u64,
        _raw: &[u8],
        _max_part_plain_bytes: u64,
    ) -> Result<Zeroizing<Vec<u8>>, OpenError> {
        Err(OpenError::Aead)
    }
    /// The keyed part addresses of a blob, if the key of its `id_epoch` is held.
    fn blob_part_addresses(&self, blob: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>>;
    /// Sign a clear item (sets `sig`).
    fn sign(&self, item: &mut Item) -> Result<(), SealError>;
    /// Sign only `H("mdbase/v1/ls-hello", nonce32 || UTF8(token))`. No arbitrary
    /// digest signing or private-key export is exposed to the transport. An epoch
    /// key is not required: authentication precedes reading the control chain.
    fn log_hello_proof(&self, _nonce: [u8; 32], _token: &str) -> Result<Signature, SealError> {
        Err(SealError::Failed("log hello proof is unsupported".into()))
    }
    /// Open a sealed item's body, from its bytes exactly as received.
    fn open(&self, item: &Item, raw: &[u8]) -> Result<Vec<u8>, OpenError>;
    /// Additive consumer-bound DATA opening. Caller must hold its shared input,
    /// metadata and crypto peak/work reservations through the returned output.
    /// This does not verify signer/policy/currentness or mint install authority.
    /// Unsupported implementations wipe/refuse, never copy via the owned API.
    fn open_bounded_borrowed(
        &self,
        _item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        aad_workspace: &mut [u8],
        _max_plain: usize,
        _admitted_crypto_peak: usize,
    ) -> Result<Vec<u8>, OpenError> {
        aad_workspace.zeroize();
        Err(OpenError::Aead)
    }
    /// The signature verifier policy evaluation uses.
    fn verifier(&self) -> &dyn SigVerifier;
    /// Learn from a valid `rekey`: record its commitment and, if this device is a
    /// recipient, unwrap the new key and the history (each checked).
    fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent;
    /// Learn from a valid `key_grant`: if it is for this device, unwrap the key and
    /// check it against the commitment of the rekey that created its epoch.
    fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent;
    /// Join-ahead (`replica::join_ahead`): learn the key of epoch `want` through a
    /// `key_grant` to this device of a later epoch, read ahead of the applied
    /// prefix, and the `rekey` that created that epoch (also read ahead). The grant's
    /// key is checked against that rekey's commitment only to open its history box;
    /// a key is installed only if this sealer already holds its epoch's commitment
    /// from an applied rekey, and the grant epoch's own key never is. `Keyed` only
    /// when `want`'s key is now held. Sealers without history refuse (`None`).
    fn accept_key_grant_ahead(
        &mut self,
        grant: &KeyGrantPayload,
        rekey: &RekeyPayload,
        want: u64,
    ) -> KeyEvent {
        let _ = (grant, rekey, want);
        KeyEvent::None
    }
    /// Build a `rekey` from `from` (the current epoch) for exactly `recipients`.
    fn build_rekey(
        &mut self,
        from: u64,
        recipients: &[Recipient],
        reason: RekeyReason,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<RekeyPayload, SealError>;
    /// This device's KEM public key (the recipient of its key wraps), when the
    /// sealer holds one (AK1: a self-grant is wrapped to it).
    fn kem_public(&self) -> Option<[u8; 32]> {
        None
    }
    /// Build a `key_grant` of `epoch`'s key for `recipient` (a cloud copy's hosted
    /// replica keying an approved device). Sealers that never grant keys refuse.
    fn build_key_grant(
        &self,
        epoch: u64,
        recipient: &Recipient,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<KeyGrantPayload, SealError> {
        let _ = (epoch, recipient, entropy);
        Err(SealError::NotKeyed)
    }
    /// Private USER-device approval. The comparison and wrap use the internally
    /// held epoch key, never a raw-key getter. Sealers without this custody deny.
    /// `account` must come from the host's current authenticated authority.
    fn approve_private_device(
        &self,
        approval: &mut crate::approval::Approver,
        policy: &crate::policy::PolicyState,
        account: Uuid,
        device: &Uuid,
        typed: &str,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<KeyGrantPayload, crate::approval::ApprovalError> {
        let _ = (approval, policy, account, device, typed, entropy);
        Err(crate::approval::ApprovalError::NotApprover)
    }
    /// The keyring, to persist with the platform's protection (`None`: nothing to keep).
    fn export(&self) -> Option<Zeroizing<Vec<u8>>>;
    /// Restore a keyring from [`Sealer::export`].
    fn import(&mut self, bytes: &[u8]) -> Result<(), SealError>;
    /// **Test only** (`testing` feature): copies of every epoch key this sealer
    /// holds, for oracles that prove no key reaches the log service (sim gate 1).
    /// Shipped crates can't enable `testing` (xtask arch rule, release-feature check).
    #[cfg(any(test, feature = "testing"))]
    fn testing_epoch_keys(&self) -> Vec<(u64, Zeroizing<[u8; 32]>)> {
        Vec::new()
    }
}

/// The production sealer: this device's keys and the collection's epoch keys.
pub struct KeyringSealer {
    collection: Uuid,
    device: Uuid,
    signer: DeviceSigner,
    kem: KemKeyPair,
    keys: Keyring,
    commits: BTreeMap<u64, B32>,
    epoch: u64,
    verifier: Ed25519Verifier,
}

impl std::fmt::Debug for KeyringSealer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "KeyringSealer(device={:?}, epoch={})",
            self.device, self.epoch
        )
    }
}

impl KeyringSealer {
    /// A sealer for `device` with its signing seed and KEM private key.
    pub fn new(
        collection: Uuid,
        device: Uuid,
        sign_seed: &[u8; 32],
        kem_sk: &[u8; 32],
    ) -> KeyringSealer {
        KeyringSealer {
            collection,
            device,
            signer: DeviceSigner::from_seed(sign_seed),
            kem: KemKeyPair::from_secret(kem_sk),
            keys: Keyring::new(),
            commits: BTreeMap::new(),
            epoch: 0,
            verifier: Ed25519Verifier,
        }
    }

    /// Open charged parsed DATA under a held epoch key. The accounting ledger
    /// precharges native lookup before checking epoch/key, then the full planned
    /// open cost and memory before allocation. Missing keys precede salt/size
    /// planning as in ordinary opening. The actual open repeats the key lookup;
    /// no raw key, continuing permit, policy or installation authority escapes.
    pub fn open_charged_borrowed<'a>(
        &self,
        item: &'a crate::mirror_install_data::Envelope<'_>,
        max_plain: usize,
    ) -> Result<crate::mirror_install_data::Plaintext<'a>, crate::mirror_install_data::Error> {
        use crate::mirror_install_data::Error;
        item.precharge_key_lookup()?;
        let epoch = item
            .borrowed()
            .epoch()
            .ok_or(Error::Open(OpenError::Aead))?;
        self.key(epoch).ok_or(Error::Open(OpenError::NoKey))?;
        item.open_after_key_check(self, max_plain)
    }

    fn key(&self, epoch: u64) -> Option<&Secret32> {
        self.keys.get(epoch)
    }
}

impl SigVerifier for Ed25519Verifier {
    fn verify(&self, pk: &[u8; 32], digest: &[u8; 32], sig: &[u8; 64]) -> bool {
        Ed25519Verifier::verify(self, pk, digest, sig)
    }
}

impl Sealer for KeyringSealer {
    fn public_identity(&self) -> Option<SealerIdentity> {
        Some(SealerIdentity {
            collection: self.collection,
            device: self.device,
            sign_pk: B32(self.signer.public()),
            kem_pk: B32(self.kem.pk),
        })
    }

    fn set_epoch(&mut self, epoch: u64) {
        self.epoch = epoch;
    }

    fn current_epoch(&self) -> Option<u64> {
        (self.epoch > 0 && self.key(self.epoch).is_some()).then_some(self.epoch)
    }

    fn idem_token(&self, mutation: &Uuid) -> Option<B16> {
        let k1 = self.key(1)?;
        Some(keys::idem_token(
            &keys::idem_key(k1, &self.collection),
            mutation,
        ))
    }

    fn seal(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        let key = *self.key(epoch).ok_or(SealError::NotKeyed)?.expose();
        let key = Zeroizing::new(key);
        item.epoch = Some(epoch);
        crate::crypto::seal::seal_item_body(&key, item, plain, compress, entropy)?;
        self.signer.sign_item(item)?;
        Ok(())
    }

    fn seal_object(
        &mut self,
        item: &mut Item,
        plain: &[u8],
        compress: bool,
        sign: bool,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(), SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        let key = Zeroizing::new(*self.key(epoch).ok_or(SealError::NotKeyed)?.expose());
        item.epoch = Some(epoch);
        crate::crypto::seal::seal_item_body(&key, item, plain, compress, entropy)?;
        if sign {
            self.signer.sign_item(item)?;
        }
        Ok(())
    }

    fn seal_bounded_record_source(
        &self,
        plain: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<
        (
            mdbn_wire::intent::BlobRef,
            Vec<crate::crypto::blob::SealedPart>,
        ),
        SealError,
    > {
        // Enforce before key lookup, hashing, allocation, or entropy use.
        if plain.len() > 1_048_576 {
            return Err(SealError::Failed("record source too large".into()));
        }
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        let key = self.key(epoch).ok_or(SealError::NotKeyed)?;
        crate::crypto::blob::seal_blob(
            key,
            epoch,
            &self.collection,
            plain,
            crate::crypto::blob::PART_SIZE,
            false,
            entropy,
        )
        .map_err(SealError::from)
    }

    fn seal_attachment_chunk(
        &self,
        context: &ChunkContextV1,
        plain: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(SealedObject, ChunkRefV1), SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        if context.attachment.collection != self.collection || context.attachment.key_epoch != epoch
        {
            return Err(SealError::Failed(
                "attachment context is not current".into(),
            ));
        }
        let key = self.key(epoch).ok_or(SealError::NotKeyed)?;
        chunked_blob::seal_chunk(key, context, plain, entropy).map_err(SealError::from)
    }

    fn attachment_chunk_in_place_check(
        &self,
        context: &ChunkContextV1,
        plain_bytes: usize,
        region_bytes: usize,
    ) -> Result<(), SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        if context.attachment.collection != self.collection || context.attachment.key_epoch != epoch
        {
            return Err(SealError::Failed(
                "attachment context is not current".into(),
            ));
        }
        self.key(epoch).ok_or(SealError::NotKeyed)?;
        chunked_blob::chunk_in_place_len(context, plain_bytes, region_bytes)?;
        Ok(())
    }

    fn seal_attachment_chunk_in_place(
        &self,
        context: &ChunkContextV1,
        region: &mut [u8],
        plain_bytes: usize,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedChunkSpan, SealError> {
        let result = (|| {
            self.attachment_chunk_in_place_check(context, plain_bytes, region.len())?;
            let key = self
                .key(context.attachment.key_epoch)
                .ok_or(SealError::NotKeyed)?;
            chunked_blob::seal_chunk_in_place(key, context, region, plain_bytes, entropy)
                .map_err(SealError::from)
        })();
        if result.is_err() {
            region.zeroize();
        }
        result
    }

    fn seal_hosted_upload_resume(
        &self,
        metadata: &UploadResumeMetadataV1,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<(SealedObject, UploadResumeRefV1), SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        if metadata.context.collection != self.collection || metadata.context.key_epoch != epoch {
            return Err(SealError::Failed(
                "upload resume context is not current".into(),
            ));
        }
        let key = self.key(epoch).ok_or(SealError::NotKeyed)?;
        upload_resume::seal_resume_metadata(key, metadata, entropy).map_err(SealError::from)
    }

    fn open_hosted_upload_resume(
        &self,
        reference: &UploadResumeRefV1,
        owner: UploadResumeOwnerV1,
        region: &mut [u8],
    ) -> Result<AuthenticatedUploadResumeV1, OpenError> {
        let result = (|| {
            let ctx = reference.context;
            if ctx.collection != self.collection || self.current_epoch() != Some(ctx.key_epoch) {
                return Err(OpenError::Aead);
            }
            let key = self.key(ctx.key_epoch).ok_or(OpenError::NoKey)?;
            upload_resume::open_resume_metadata(key, reference, owner, region)
                .map_err(|_| OpenError::Aead)
        })();
        region.zeroize();
        result
    }

    fn open_hosted_upload_committed_chunk_in_place(
        &self,
        resume: &AuthenticatedUploadResumeV1,
        index: u64,
        region: &mut [u8],
    ) -> Result<std::ops::Range<usize>, OpenError> {
        let result = (|| {
            let ctx = resume.metadata().context;
            if ctx.collection != self.collection || self.current_epoch() != Some(ctx.key_epoch) {
                return Err(OpenError::Aead);
            }
            let key = self.key(ctx.key_epoch).ok_or(OpenError::NoKey)?;
            upload_resume::open_committed_chunk_in_place(key, resume, index, region)
                .map_err(|_| OpenError::Aead)
        })();
        if result.is_err() {
            region.zeroize();
        }
        result
    }

    fn seal_attachment_manifest(
        &self,
        manifest: &ManifestV1,
        limits: AttachmentLimits,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<SealedObject, SealError> {
        let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
        if manifest.context.collection != self.collection || manifest.context.key_epoch != epoch {
            return Err(SealError::Failed(
                "attachment context is not current".into(),
            ));
        }
        let key = self.key(epoch).ok_or(SealError::NotKeyed)?;
        chunked_blob::seal_manifest(key, manifest, limits, entropy).map_err(SealError::from)
    }

    fn open_attachment_manifest(
        &self,
        descriptor: &AttachmentRefV1,
        expected: ExpectedFileV1,
        raw: &[u8],
        limits: AttachmentLimits,
    ) -> Result<VerifiedManifestV1, OpenError> {
        if descriptor.context.collection != self.collection {
            return Err(OpenError::Aead);
        }
        let key = self
            .key(descriptor.context.key_epoch)
            .ok_or(OpenError::NoKey)?;
        chunked_blob::open_manifest(key, descriptor, expected, raw, limits)
            .map_err(|_| OpenError::Aead)
    }

    fn open_attachment_chunk(
        &self,
        manifest: &VerifiedManifestV1,
        index: u64,
        raw: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, OpenError> {
        let context = manifest.descriptor().context;
        if context.collection != self.collection {
            return Err(OpenError::Aead);
        }
        let key = self.key(context.key_epoch).ok_or(OpenError::NoKey)?;
        chunked_blob::open_chunk(key, manifest, index, raw).map_err(|_| OpenError::Aead)
    }

    fn open_attachment_chunk_in_place(
        &self,
        manifest: &VerifiedManifestV1,
        index: u64,
        raw: &mut [u8],
    ) -> Result<std::ops::Range<usize>, OpenError> {
        let context = manifest.descriptor().context;
        if context.collection != self.collection {
            raw.zeroize();
            return Err(OpenError::Aead);
        }
        let Some(key) = self.key(context.key_epoch) else {
            raw.zeroize();
            return Err(OpenError::NoKey);
        };
        chunked_blob::open_chunk_in_place(key, manifest, index, raw).map_err(|_| OpenError::Aead)
    }

    fn open_blob_part(
        &self,
        descriptor: &mdbn_wire::intent::BlobRef,
        index: u64,
        raw: &[u8],
        max_part_plain_bytes: u64,
    ) -> Result<Zeroizing<Vec<u8>>, OpenError> {
        use mdbn_wire::schema::Wire;
        if max_part_plain_bytes > crate::crypto::blob::MAX_PART_SIZE {
            return Err(OpenError::Aead);
        }
        crate::crypto::blob::validate_blob_ref(descriptor).map_err(|_| OpenError::Aead)?;
        let len =
            crate::crypto::blob::expected_part_len(descriptor, index).ok_or(OpenError::Aead)?;
        if len > max_part_plain_bytes || raw.len() as u64 > crate::crypto::blob::max_sealed_len(len)
        {
            return Err(OpenError::Aead);
        }
        let item = Item::from_bytes(raw).map_err(|_| OpenError::Aead)?;
        if item.epoch != Some(descriptor.id_epoch) {
            return Err(OpenError::Aead);
        }
        let key = self.key(descriptor.id_epoch).ok_or(OpenError::NoKey)?;
        let cid = crate::crypto::blob::content_key(key, &self.collection);
        let expected =
            crate::crypto::blob::blob_id(&cid, &descriptor.plain_hash.0, descriptor.size);
        if !crate::crypto::ct_eq(&expected, &descriptor.blob_id.0) {
            return Err(OpenError::Aead);
        }
        crate::crypto::blob::open_part(key, &self.collection, descriptor, index, raw)
            .map(Zeroizing::new)
            .map_err(|_| OpenError::Aead)
    }

    fn blob_part_addresses(&self, blob: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
        let k = self.key(blob.id_epoch)?;
        let k_cid = crate::crypto::blob::content_key(k, &self.collection);
        crate::crypto::blob::part_addresses(&k_cid, blob).ok()
    }

    fn sign(&self, item: &mut Item) -> Result<(), SealError> {
        self.signer.sign_item(item)?;
        Ok(())
    }

    fn log_hello_proof(&self, nonce: [u8; 32], token: &str) -> Result<Signature, SealError> {
        if token.is_empty() || token.len() > MAX_LOG_TOKEN_BYTES {
            return Err(SealError::Failed("invalid log hello token length".into()));
        }
        let mut message = Zeroizing::new(Vec::with_capacity(32 + token.len()));
        message.extend_from_slice(&nonce);
        message.extend_from_slice(token.as_bytes());
        let digest = mdbn_wire::hash::h("mdbase/v1/ls-hello", &message);
        Ok(mdbn_wire::common::B64(self.signer.sign_digest(&digest.0)))
    }

    fn open(&self, item: &Item, raw: &[u8]) -> Result<Vec<u8>, OpenError> {
        let epoch = item.epoch.ok_or(OpenError::Aead)?;
        let key = self.key(epoch).ok_or(OpenError::NoKey)?;
        crate::crypto::raw::open_item_bytes(key.expose(), raw).map_err(|_| OpenError::Aead)
    }

    fn open_bounded_borrowed(
        &self,
        item: &crate::crypto::raw::BorrowedEnvelope<'_>,
        aad_workspace: &mut [u8],
        max_plain: usize,
        admitted_crypto_peak: usize,
    ) -> Result<Vec<u8>, OpenError> {
        let epoch = item.epoch().ok_or(OpenError::Aead)?;
        let key = self.key(epoch).ok_or(OpenError::NoKey)?;
        crate::crypto::raw::open_envelope_borrowed_bounded(
            key.expose(),
            item,
            aad_workspace,
            max_plain,
            admitted_crypto_peak,
        )
        .map_err(|_| OpenError::Aead)
    }

    fn verifier(&self) -> &dyn SigVerifier {
        &self.verifier
    }

    fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent {
        self.commits.insert(p.epoch, p.commit);
        match keys::open_rekey(p, &self.collection, &self.device, &self.kem) {
            Ok(RekeyOpened::Keys { key, history }) => {
                for h in history {
                    let e = h.epoch();
                    // An older key is used only once checked against the
                    // commitment of the rekey that created it.
                    if let Some(c) = self.commits.get(&e).copied()
                        && let Ok((e, k)) = h.verify(&self.collection, &c)
                    {
                        self.keys.insert(e, k);
                    }
                }
                self.keys.insert(p.epoch, key);
                KeyEvent::Keyed { epoch: p.epoch }
            }
            Ok(RekeyOpened::Inconsistent) => KeyEvent::Inconsistent,
            Ok(RekeyOpened::NotARecipient) => KeyEvent::None,
            Err(_) => KeyEvent::Inconsistent,
        }
    }

    fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent {
        if p.recipient != self.device {
            return KeyEvent::None;
        }
        let Some(commit) = self.commits.get(&p.epoch).copied() else {
            return KeyEvent::Inconsistent;
        };
        match keys::open_key_grant(p, &self.collection, &self.kem, &commit) {
            Ok(k) => {
                self.keys.insert(p.epoch, k);
                KeyEvent::Keyed { epoch: p.epoch }
            }
            Err(_) => KeyEvent::Inconsistent,
        }
    }

    fn accept_key_grant_ahead(
        &mut self,
        grant: &KeyGrantPayload,
        rekey: &RekeyPayload,
        want: u64,
    ) -> KeyEvent {
        if grant.recipient != self.device
            || rekey.epoch != grant.epoch
            || rekey.from == 0
            || want >= grant.epoch
        {
            return KeyEvent::None;
        }
        // The grant epoch's key, against the commitment read ahead: used only to
        // open the history box, never installed.
        let Ok(key) = keys::open_key_grant(grant, &self.collection, &self.kem, &rekey.commit)
        else {
            return KeyEvent::Inconsistent;
        };
        let Ok(history) = keys::open_history(&key, &self.collection, grant.epoch, &rekey.history)
        else {
            return KeyEvent::Inconsistent;
        };
        drop(key);
        // An older key is installed only once checked against the
        // commitment of a rekey this replica applied in order. Epochs without one
        // are skipped; any mismatch installs nothing.
        let mut verified = Vec::new();
        for h in history {
            let Some(c) = self.commits.get(&h.epoch()).copied() else {
                continue;
            };
            match h.verify(&self.collection, &c) {
                Ok(k) => verified.push(k),
                Err(_) => return KeyEvent::Inconsistent,
            }
        }
        if !verified.iter().any(|(e, _)| *e == want) {
            return KeyEvent::None;
        }
        for (e, k) in verified {
            self.keys.insert(e, k);
        }
        KeyEvent::Keyed { epoch: want }
    }

    #[cfg(any(test, feature = "testing"))]
    fn testing_epoch_keys(&self) -> Vec<(u64, Zeroizing<[u8; 32]>)> {
        self.keys
            .iter()
            .map(|(e, k)| (e, Zeroizing::new(*k.expose())))
            .collect()
    }

    fn build_rekey(
        &mut self,
        from: u64,
        recipients: &[Recipient],
        reason: RekeyReason,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<RekeyPayload, SealError> {
        let (p, _key) = keys::build_rekey(
            &self.collection,
            from,
            &self.keys,
            recipients,
            reason,
            entropy,
        )?;
        // The key is learned when the rekey is applied (this device is a recipient),
        // so a rekey that loses the race never leaves a key behind.
        Ok(p)
    }

    fn build_key_grant(
        &self,
        epoch: u64,
        recipient: &Recipient,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<KeyGrantPayload, SealError> {
        let key = self.key(epoch).ok_or(SealError::NotKeyed)?;
        Ok(keys::build_key_grant(
            &self.collection,
            epoch,
            key,
            recipient,
            entropy,
        )?)
    }

    fn approve_private_device(
        &self,
        approval: &mut crate::approval::Approver,
        policy: &crate::policy::PolicyState,
        account: Uuid,
        device: &Uuid,
        typed: &str,
        entropy: &mut dyn CsprngEntropy,
    ) -> Result<KeyGrantPayload, crate::approval::ApprovalError> {
        use crate::approval::ApprovalError as E;
        use mdbn_wire::policy::DeviceKind;
        let me = policy.devices.get(&self.device).ok_or(E::NotApprover)?;
        let target = policy.devices.get(device).ok_or(E::NotWaiting)?;
        if device.0 == [0; 16]
            || target.account == crate::policy::SERVICE_ACCOUNT
            || !policy.members.contains_key(&target.account)
            || !matches!(
                target.kind,
                DeviceKind::Desktop | DeviceKind::Mobile | DeviceKind::AppRuntime | DeviceKind::Cli
            )
        {
            return Err(E::NotWaiting);
        }
        if !approval.bound_to(self.collection, self.device)
            || account.0 == [0; 16]
            || account == crate::policy::SERVICE_ACCOUNT
            || me.account != account
            || me.sign_pk.0 != self.signer.public()
            || me.kem_pk.0 != self.kem.pk
            || policy.rekey_required
            || policy.epoch == 0
            || self.current_epoch() != Some(policy.epoch)
        {
            return Err(E::NotApprover);
        }
        let key = self.key(policy.epoch).ok_or(E::NotApprover)?;
        approval.approve(policy, device, typed, key, entropy)
    }

    fn kem_public(&self) -> Option<[u8; 32]> {
        Some(self.kem.pk)
    }

    fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
        let mut out = Zeroizing::new(Vec::new());
        let k = self.keys.to_bytes();
        out.extend_from_slice(&(k.len() as u64).to_be_bytes());
        out.extend_from_slice(&k);
        for (e, c) in &self.commits {
            out.extend_from_slice(&e.to_be_bytes());
            out.extend_from_slice(&c.0);
        }
        Some(out)
    }

    fn import(&mut self, b: &[u8]) -> Result<(), SealError> {
        let bad = || SealError::Failed("keyring does not decode".into());
        let n = usize::try_from(u64::from_be_bytes(
            b.get(..8).ok_or_else(bad)?.try_into().map_err(|_| bad())?,
        ))
        .map_err(|_| bad())?;
        let k = b.get(8..8 + n).ok_or_else(bad)?;
        self.keys = Keyring::from_bytes(k)?;
        let rest = &b[8 + n..];
        if !rest.len().is_multiple_of(40) {
            return Err(bad());
        }
        self.commits = rest
            .chunks(40)
            .map(|c| {
                let mut e = [0u8; 8];
                e.copy_from_slice(&c[..8]);
                let mut h = [0u8; 32];
                h.copy_from_slice(&c[8..]);
                (u64::from_be_bytes(e), B32(h))
            })
            .collect();
        Ok(())
    }
}

#[cfg(any(test, feature = "testing"))]
pub use plain::PlainSealer;

#[cfg(any(test, feature = "testing"))]
mod plain {
    use mdbn_wire::common::{B16, B32, B64, Bytes, Hash, Uuid};
    use mdbn_wire::envelope::{
        Item, KeyGrantPayload, KeyWrap, RekeyPayload, RekeyReason, SealedBox,
    };
    use zeroize::Zeroizing;

    use super::{KeyEvent, OpenError, SealError, Sealer};
    use crate::crypto::CsprngEntropy;
    use crate::crypto::keys::Recipient;
    use crate::policy::SigVerifier;

    /// **Test only.** No encryption: bodies are the plaintext, every signature is 64
    /// zero bytes, and the verifier accepts exactly those. Rekeys carry placeholder
    /// wraps. Every replica sharing a log in a test must use it.
    #[derive(Debug, Clone)]
    pub struct PlainSealer {
        epoch: u64,
        keyed: std::collections::BTreeSet<u64>,
        device: Uuid,
    }

    impl PlainSealer {
        /// A test sealer for `device`.
        pub fn for_device(device: Uuid) -> PlainSealer {
            PlainSealer {
                epoch: 0,
                keyed: Default::default(),
                device,
            }
        }
    }

    /// Accepts exactly the all-zero signature.
    #[derive(Debug, Clone, Copy)]
    pub struct ZeroVerifier;

    impl SigVerifier for ZeroVerifier {
        fn verify(&self, _pk: &[u8; 32], _digest: &[u8; 32], sig: &[u8; 64]) -> bool {
            *sig == [0; 64]
        }
    }

    impl Sealer for PlainSealer {
        fn set_epoch(&mut self, epoch: u64) {
            self.epoch = epoch;
        }
        fn current_epoch(&self) -> Option<u64> {
            (self.epoch > 0 && self.keyed.contains(&self.epoch)).then_some(self.epoch)
        }
        fn idem_token(&self, mutation: &Uuid) -> Option<B16> {
            let h: Hash = mdbn_wire::hash::h("mdbase/v1/idem", &mutation.0);
            let mut t = [0u8; 16];
            t.copy_from_slice(&h.0[..16]);
            Some(B16(t))
        }
        fn seal(
            &mut self,
            item: &mut Item,
            plain: &[u8],
            compress: bool,
            entropy: &mut dyn CsprngEntropy,
        ) -> Result<(), SealError> {
            self.seal_object(item, plain, compress, true, entropy)
        }
        fn seal_object(
            &mut self,
            item: &mut Item,
            plain: &[u8],
            _compress: bool,
            sign: bool,
            entropy: &mut dyn CsprngEntropy,
        ) -> Result<(), SealError> {
            let epoch = self.current_epoch().ok_or(SealError::NotKeyed)?;
            let mut salt = [0u8; 16];
            entropy.fill(&mut salt);
            item.epoch = Some(epoch);
            item.salt = Some(B16(salt));
            item.body = Bytes(plain.to_vec());
            item.sig = sign.then_some(B64([0; 64]));
            Ok(())
        }
        fn blob_part_addresses(&self, blob: &mdbn_wire::intent::BlobRef) -> Option<Vec<B32>> {
            Some(
                (0..blob.part_count())
                    .map(|i| {
                        let mut m = blob.blob_id.0.to_vec();
                        m.extend_from_slice(&(i as u32).to_be_bytes());
                        mdbn_wire::hash::h("test/blob-part", &m)
                    })
                    .collect(),
            )
        }
        fn sign(&self, item: &mut Item) -> Result<(), SealError> {
            item.sig = Some(B64([0; 64]));
            Ok(())
        }
        fn open(&self, item: &Item, _raw: &[u8]) -> Result<Vec<u8>, OpenError> {
            match item.epoch {
                Some(e) if self.keyed.contains(&e) => Ok(item.body.0.clone()),
                _ => Err(OpenError::NoKey),
            }
        }
        fn verifier(&self) -> &dyn SigVerifier {
            &ZeroVerifier
        }
        fn accept_rekey(&mut self, p: &RekeyPayload) -> KeyEvent {
            if p.wraps.iter().any(|w| w.device == self.device) {
                self.keyed.extend(1..=p.epoch);
                KeyEvent::Keyed { epoch: p.epoch }
            } else {
                KeyEvent::None
            }
        }
        fn accept_key_grant(&mut self, p: &KeyGrantPayload) -> KeyEvent {
            if p.recipient == self.device {
                self.keyed.extend(1..=p.epoch);
                KeyEvent::Keyed { epoch: p.epoch }
            } else {
                KeyEvent::None
            }
        }
        fn accept_key_grant_ahead(
            &mut self,
            grant: &KeyGrantPayload,
            rekey: &RekeyPayload,
            want: u64,
        ) -> KeyEvent {
            // Placeholder history: every epoch below the grant's.
            if grant.recipient == self.device
                && rekey.epoch == grant.epoch
                && rekey.from != 0
                && (1..grant.epoch).contains(&want)
            {
                self.keyed.extend(1..=want);
                KeyEvent::Keyed { epoch: want }
            } else {
                KeyEvent::None
            }
        }
        fn build_rekey(
            &mut self,
            from: u64,
            recipients: &[Recipient],
            reason: RekeyReason,
            _entropy: &mut dyn CsprngEntropy,
        ) -> Result<RekeyPayload, SealError> {
            let mut rs: Vec<Uuid> = recipients.iter().map(|r| r.device).collect();
            rs.sort();
            rs.dedup();
            Ok(RekeyPayload {
                epoch: from + 1,
                from,
                commit: B32([0; 32]),
                wraps: rs
                    .into_iter()
                    .map(|device| KeyWrap {
                        device,
                        enc: B32([0; 32]),
                        ct: mdbn_wire::common::Bytes(vec![0; 48]),
                    })
                    .collect(),
                history: SealedBox {
                    salt: B16([0; 16]),
                    ct: Bytes(Vec::new()),
                },
                reason,
            })
        }
        fn build_key_grant(
            &self,
            epoch: u64,
            recipient: &Recipient,
            _entropy: &mut dyn CsprngEntropy,
        ) -> Result<KeyGrantPayload, SealError> {
            Ok(KeyGrantPayload {
                recipient: recipient.device,
                epoch,
                wrap: KeyWrap {
                    device: recipient.device,
                    enc: B32([0; 32]),
                    ct: mdbn_wire::common::Bytes(vec![0; 48]),
                },
            })
        }
        fn export(&self) -> Option<Zeroizing<Vec<u8>>> {
            Some(Zeroizing::new(
                self.keyed.iter().flat_map(|e| e.to_be_bytes()).collect(),
            ))
        }
        fn import(&mut self, b: &[u8]) -> Result<(), SealError> {
            self.keyed = b
                .chunks(8)
                .filter_map(|c| <[u8; 8]>::try_from(c).ok())
                .map(u64::from_be_bytes)
                .collect();
            Ok(())
        }
    }
}

#[cfg(any(test, feature = "testing"))]
pub use plain::ZeroVerifier;

#[cfg(test)]
#[path = "seal_approval_tests.rs"]
mod approval_tests;
