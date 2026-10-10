//! Server-only, purpose-separated encrypted hosted-upload resume metadata.
//! This authenticates a journal, not current grant/session/wake authority or LS
//! durability. Native transfer callers must derive the expected owner from the
//! CURRENT session and recheck policy/folder/account/epoch before/after awaits.
//! SQL may retain only the opaque ciphertext reference and bounded progress:
//! NEVER this plaintext metadata, chunk plaintext hashes, or encoded object.

use super::*;

#[cfg(test)]
mod tests;

const DOMAIN: &str = "mdbase/v1/hosted-upload-resume";
/// Typed hosted file bound: 128 complete 8 MiB chunks plus the final manifest.
pub const FILE_BYTES: u64 = 1 << 30;
/// Bounds metadata allocation independently of the 9 MiB shared chunk region.
pub const METADATA_BYTES: usize = 32 << 10;
const PATH_BYTES: usize = 4096;

/// Native session-derived subject plus the caller's transfer identity. These
/// fields select the resume KDF/AAD, never grant continuing authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadResumeOwnerV1 {
    /// Current grant.
    pub grant: Uuid,
    /// Current authenticated client key.
    pub client_pk: B32,
    /// Current grant account.
    pub account: Uuid,
    /// Wire transfer identity, bound to this exact subject.
    pub transfer: Uuid,
}
impl UploadResumeOwnerV1 {
    fn fields(&self) -> [Cbor; 4] {
        [
            Cbor::Bytes(self.grant.0.to_vec()),
            Cbor::Bytes(self.client_pk.0.to_vec()),
            Cbor::Bytes(self.account.0.to_vec()),
            Cbor::Bytes(self.transfer.0.to_vec()),
        ]
    }
}

/// Writer-side journal. Construction/validation alone authenticates NOTHING;
/// only native transfer code may assemble it from its native-owned context and
/// confirmed LS commit replies. Kept encrypted in R2, never copied to SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadResumeMetadataV1 {
    /// Stable chunk placement context under the current held epoch.
    pub context: AttachmentContextV1,
    /// Native session-derived creator.
    pub owner: UploadResumeOwnerV1,
    /// Original native-minted file identity (not a client-selected replacement).
    pub file: Uuid,
    /// Original delegated mutation identity/receipt scope.
    pub mutation: Uuid,
    /// Exact original destination, freshly checked against current folders.
    pub path: String,
    /// Immutable declared total, including uncommitted suffix.
    pub total_plain_bytes: u64,
    /// Original optional whole-file digest must survive resume.
    pub expected_whole_hash: Option<Hash>,
    /// Bounded native-clock expiry; does NOT extend LS object grace.
    pub expires_at_ms: u64,
    /// Contiguous prefix of CONFIRMED committed sealed chunks, never packet ACKs.
    pub chunks: Vec<ChunkRefV1>,
}
impl UploadResumeMetadataV1 {
    /// Structural bounds only; not policy, custody, ownership or durability.
    pub fn validate(&self) -> Result<(), CryptoError> {
        self.context.validate()?;
        if self.total_plain_bytes > FILE_BYTES
            || self.path.is_empty()
            || self.path.len() > PATH_BYTES
            || self.expires_at_ms == 0
            || self.expires_at_ms > (1 << 53) - 1
        {
            return Err(CryptoError::TooLarge);
        }
        let count = self
            .total_plain_bytes
            .div_ceil(u64::from(CHUNK_BYTES))
            .max(1);
        if self.chunks.len() as u64 > count {
            return Err(CryptoError::TooLarge);
        }
        for (i, chunk) in self.chunks.iter().enumerate() {
            let ctx = self.chunk_context(i as u64)?;
            if chunk.plain_bytes != ctx.plain_bytes
                || chunk.sealed_bytes
                    != chunk_in_place_len(&ctx, ctx.plain_bytes as usize, MAX_SEALED)? as u64
            {
                return Err(CryptoError::Open);
            }
        }
        Ok(())
    }
    fn chunk_context(&self, index: u64) -> Result<ChunkContextV1, CryptoError> {
        let start = index
            .checked_mul(u64::from(CHUNK_BYTES))
            .ok_or(CryptoError::Open)?;
        let count = self
            .total_plain_bytes
            .div_ceil(u64::from(CHUNK_BYTES))
            .max(1);
        if index >= count {
            return Err(CryptoError::Open);
        }
        Ok(ChunkContextV1 {
            attachment: self.context,
            index,
            // Finality comes from the ORIGINAL total, NOT the prefix length.
            final_chunk: index + 1 == count,
            plain_bytes: self
                .total_plain_bytes
                .checked_sub(start)
                .ok_or(CryptoError::Open)?
                .min(u64::from(CHUNK_BYTES)),
        })
    }
    fn encode(&self) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        self.validate()?;
        let mut fields = self.context.fields();
        fields.extend(self.owner.fields());
        fields.extend([
            Cbor::Bytes(self.file.0.to_vec()),
            Cbor::Bytes(self.mutation.0.to_vec()),
            Cbor::Text(self.path.clone()),
            Cbor::Uint(self.total_plain_bytes),
            self.expected_whole_hash
                .map_or(Cbor::Null, |h| Cbor::Bytes(h.0.to_vec())),
            Cbor::Uint(self.expires_at_ms),
            Cbor::Array(
                self.chunks
                    .iter()
                    .map(|c| {
                        Cbor::Array(vec![
                            Cbor::Bytes(c.cipher_hash.0.to_vec()),
                            Cbor::Uint(c.sealed_bytes),
                            Cbor::Bytes(c.plain_hash.0.to_vec()),
                            Cbor::Uint(c.plain_bytes),
                        ])
                    })
                    .collect(),
            ),
        ]);
        let bytes =
            Zeroizing::new(cbor::encode(&Cbor::Array(fields)).map_err(|_| CryptoError::Encode)?);
        if bytes.len() > METADATA_BYTES {
            return Err(CryptoError::TooLarge);
        }
        Ok(bytes)
    }
    fn decode(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() > METADATA_BYTES {
            return Err(CryptoError::TooLarge);
        }
        let mut r = Reader { bytes, pos: 0 };
        if r.head(4)? != 16 {
            return Err(CryptoError::Open);
        }
        r.want(1)?;
        let context = AttachmentContextV1 {
            collection: B16(r.fixed::<16>()?),
            key_epoch: r.uint()?,
            attachment_id: B32(r.fixed::<32>()?),
            chunk_bytes: u32::try_from(r.uint()?).map_err(|_| CryptoError::Open)?,
        };
        let owner = UploadResumeOwnerV1 {
            grant: B16(r.fixed::<16>()?),
            client_pk: B32(r.fixed::<32>()?),
            account: B16(r.fixed::<16>()?),
            transfer: B16(r.fixed::<16>()?),
        };
        let file = B16(r.fixed::<16>()?);
        let mutation = B16(r.fixed::<16>()?);
        let size = usize::try_from(r.head(3)?).map_err(|_| CryptoError::Open)?;
        if size > PATH_BYTES {
            return Err(CryptoError::TooLarge);
        }
        let end = r.pos.checked_add(size).ok_or(CryptoError::Open)?;
        let path = std::str::from_utf8(r.bytes.get(r.pos..end).ok_or(CryptoError::Open)?)
            .map_err(|_| CryptoError::Open)?
            .to_owned();
        r.pos = end;
        let total_plain_bytes = r.uint()?;
        let expected_whole_hash = if r.bytes.get(r.pos) == Some(&0xf6) {
            r.pos += 1;
            None
        } else {
            Some(B32(r.fixed::<32>()?))
        };
        let expires_at_ms = r.uint()?;
        let count = usize::try_from(r.head(4)?).map_err(|_| CryptoError::Open)?;
        if total_plain_bytes > FILE_BYTES
            || count as u64 > total_plain_bytes.div_ceil(u64::from(CHUNK_BYTES)).max(1)
        {
            return Err(CryptoError::TooLarge);
        }
        // Count is <=128 BEFORE reserve; minimal CBOR and exact arities only.
        let mut chunks = Vec::with_capacity(count);
        for _ in 0..count {
            if r.head(4)? != 4 {
                return Err(CryptoError::Open);
            }
            chunks.push(ChunkRefV1 {
                cipher_hash: B32(r.fixed::<32>()?),
                sealed_bytes: r.uint()?,
                plain_hash: B32(r.fixed::<32>()?),
                plain_bytes: r.uint()?,
            });
        }
        r.finish()?;
        let out = Self {
            context,
            owner,
            file,
            mutation,
            path,
            total_plain_bytes,
            expected_whole_hash,
            expires_at_ms,
            chunks,
        };
        out.validate()?;
        Ok(out)
    }
}

/// SQL-safe opaque reference only. This is NOT an authority or commit proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadResumeRefV1 {
    /// Stable placement (must match current collection/epoch before work).
    pub context: AttachmentContextV1,
    /// SHA256 of the complete encrypted metadata Item.
    pub cipher_hash: Hash,
    /// Exact encrypted Item length, independently bounded.
    pub sealed_bytes: u64,
}
/// AEAD-authenticated metadata under the EXPECTED subject/purpose. No unchecked
/// constructor/From and no promotion to VerifiedManifestV1. Current authority
/// must still be established independently at every native boundary.
#[derive(Debug)]
pub struct AuthenticatedUploadResumeV1 {
    metadata: UploadResumeMetadataV1,
}
impl AuthenticatedUploadResumeV1 {
    /// Immutable authenticated metadata; native only, never exposed by the ABI.
    pub fn metadata(&self) -> &UploadResumeMetadataV1 {
        &self.metadata
    }
}
fn binding(context: AttachmentContextV1, owner: UploadResumeOwnerV1) -> Cbor {
    let mut fields = context.fields();
    fields.extend(owner.fields());
    Cbor::Array(fields)
}
/// Maximum canonical complete encrypted metadata Item, before input allocation.
pub fn max_sealed_bytes(epoch: u64) -> Result<usize, CryptoError> {
    let header = item_header(B16([0; 16]), epoch, B16([0; 16]))?;
    let body = shape(METADATA_BYTES)?.2;
    Ok(bounded_item_prefix(&header, body)?.len() + body)
}
/// Pure bounded metadata seal; custody/currentness precede this in Sealer. This
/// alone does NOT establish LS commit or grant authority.
pub fn seal_resume_metadata(
    key: &Secret32,
    metadata: &UploadResumeMetadataV1,
    entropy: &mut dyn CsprngEntropy,
) -> Result<(SealedObject, UploadResumeRefV1), CryptoError> {
    let plain = metadata.encode()?; // all structural bounds BEFORE entropy
    let object = seal_object(
        key,
        metadata.context,
        DOMAIN,
        binding(metadata.context, metadata.owner),
        &plain,
        entropy,
    )?;
    let reference = UploadResumeRefV1 {
        context: metadata.context,
        cipher_hash: object.cipher_hash,
        sealed_bytes: object.bytes.len() as u64,
    };
    Ok((object, reference))
}
/// Authenticate complete metadata in the caller's shared region; owner is
/// derived from the new CURRENT session, not trusted from SQL. Always wipe the
/// complete supplied region on success/error: parsed metadata remains native.
pub fn open_resume_metadata(
    key: &Secret32,
    reference: &UploadResumeRefV1,
    owner: UploadResumeOwnerV1,
    region: &mut [u8],
) -> Result<AuthenticatedUploadResumeV1, CryptoError> {
    let result = (|| {
        reference.context.validate()?;
        let size = usize::try_from(reference.sealed_bytes).map_err(|_| CryptoError::TooLarge)?;
        if region.len() > MAX_SEALED
            || size > region.len()
            || size > max_sealed_bytes(reference.context.key_epoch)?
        {
            return Err(CryptoError::TooLarge);
        }
        let plain = open_object(
            key,
            reference.context,
            (DOMAIN, binding(reference.context, owner)),
            &region[..size],
            reference.cipher_hash,
            None,
            METADATA_BYTES,
        )?;
        let metadata = UploadResumeMetadataV1::decode(&plain)?;
        if metadata.context != reference.context || metadata.owner != owner {
            return Err(CryptoError::Open);
        }
        Ok(AuthenticatedUploadResumeV1 { metadata })
    })();
    region.zeroize();
    result
}
/// Reopen ONLY a committed-prefix chunk from the authenticated resume metadata.
/// Original total determines finality; no fabricated complete manifest. Native
/// callers consume plaintext only to rebuild the digest, never send it to apps.
/// Every returned error wipes the ENTIRE supplied fixed region.
pub fn open_committed_chunk_in_place(
    key: &Secret32,
    resume: &AuthenticatedUploadResumeV1,
    index: u64,
    region: &mut [u8],
) -> Result<std::ops::Range<usize>, CryptoError> {
    let result = (|| {
        let chunk = resume
            .metadata
            .chunks
            .get(usize::try_from(index).map_err(|_| CryptoError::Open)?)
            .ok_or(CryptoError::Open)?;
        let ctx = resume.metadata.chunk_context(index)?;
        let size = usize::try_from(chunk.sealed_bytes).map_err(|_| CryptoError::TooLarge)?;
        if region.len() > MAX_SEALED || size > region.len() {
            return Err(CryptoError::TooLarge);
        }
        let range = open_bound_chunk_in_place(key, &ctx, chunk, &mut region[..size])?;
        region[size..].zeroize();
        Ok(range)
    })();
    if result.is_err() {
        region.zeroize();
    }
    result
}
