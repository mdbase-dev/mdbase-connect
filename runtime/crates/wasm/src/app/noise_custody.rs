//! Fixed native Noise-only custody. No plaintext seed/export/generic crypto ABI.
use mdbn_replica::crypto::{
    CsprngEntropy, Secret32, hkdf32,
    hpke::KemKeyPair,
    seal::{open_with_salt, seal_with_salt},
    sign::DeviceSigner,
};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, Uuid},
    schema::Wire,
};
// The decrypted fixed secret is owned only here and wiped on EVERY exit.
struct Plain(Vec<u8>);
impl Drop for Plain {
    fn drop(&mut self) {
        super::wipe(&mut self.0);
    }
}

pub(super) struct NoiseCustody {
    root: Option<Secret32>,
    device: Uuid,
    sign_pk: [u8; 32],
    kem_pk: [u8; 32],
    attempted: bool,
    active: Option<Active>,
}
struct Active {
    connector: Uuid,
    installation: Uuid,
    seed: Secret32,
    public: [u8; 32],
}
impl NoiseCustody {
    pub(super) fn new(sign: &[u8; 32], kem: &[u8; 32], device: Uuid) -> Self {
        Self {
            root: Some(hkdf32(sign, &device.0, b"mdbase/v1/app-noise-custody-root")),
            device,
            sign_pk: DeviceSigner::from_seed(sign).public(),
            kem_pk: KemKeyPair::from_secret(kem).pk,
            attempted: false,
            active: None,
        }
    }
    pub(super) fn retire(&mut self) {
        self.root = None;
        self.active = None;
        self.attempted = true;
    }
    /// Consumes this lifetime's ONLY initialization attempt, including failed
    /// reopen. Mode is explicit: no corrupt/missing envelope => fresh fallback.
    /// Outer platform custody unwrap occurs before this synchronous host call.
    pub(super) fn init(
        &mut self,
        connector: Uuid,
        bytes: &[u8],
        entropy: &mut dyn CsprngEntropy,
    ) -> Option<Vec<u8>> {
        if self.attempted {
            return None;
        }
        self.attempted = true;
        if bytes.len() > 1024 || connector.0 == [0; 16] || self.device.0 == [0; 16] {
            return None;
        }
        let Cbor::Map(fields) = cbor::decode(bytes).ok()? else {
            return None;
        };
        if fields.len() != 3
            || fields
                .iter()
                .enumerate()
                .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
        {
            return None;
        }
        let installation = B16::from_cbor(&fields[0].1).ok()?;
        if installation.0 == [0; 16] {
            return None;
        }
        let Cbor::Uint(mode) = fields[1].1 else {
            return None;
        };
        let Cbor::Bytes(ref envelope) = fields[2].1 else {
            return None;
        };
        let scope = cbor::encode(&Cbor::Array(vec![
            Cbor::Uint(1),
            self.device.to_cbor(),
            connector.to_cbor(),
            installation.to_cbor(),
        ]))
        .ok()?;
        let key = hkdf32(
            self.root.as_ref()?.expose(),
            &scope,
            b"mdbase/v1/app-noise-custody-key",
        );
        let (seed, public, salt, body) = match mode {
            0 if envelope.is_empty() => {
                // Independent OS/CSPRNG entropy, NEVER sign/KEM-derived identity.
                let seed = Secret32::random(entropy);
                let public = KemKeyPair::from_secret(seed.expose()).pk;
                if public == self.kem_pk {
                    return None;
                }
                let mut salt = [0u8; 16];
                entropy.fill(&mut salt);
                let aad = self.aad(&scope, &public)?;
                let body = seal_with_salt(key.expose(), &salt, &aad, seed.expose(), false).ok()?;
                (seed, public, salt, body)
            }
            1 if !envelope.is_empty() => {
                let Cbor::Map(e) = cbor::decode(envelope).ok()? else {
                    return None;
                };
                if e.len() != 5
                    || e.iter()
                        .enumerate()
                        .any(|(i, (k, _))| *k != Cbor::Uint(i as u64))
                    || e[0].1 != Cbor::Uint(1)
                    || e[1].1 != Cbor::Bytes(scope.clone())
                {
                    return None;
                }
                let public = mdbn_wire::common::B32::from_cbor(&e[2].1).ok()?.0;
                let salt = B16::from_cbor(&e[3].1).ok()?.0;
                let Cbor::Bytes(ref body) = e[4].1 else {
                    return None;
                };
                // Native produces fixed32-byte, uncompressed Padme-framed body60.
                // No caller-sized AEAD/decompression buffers or alternate geometry.
                if body.len() != 60 || public == self.kem_pk {
                    return None;
                }
                let aad = self.aad(&scope, &public)?;
                let plain = Plain(open_with_salt(key.expose(), &salt, &aad, body).ok()?);
                let seed = Secret32(<[u8; 32]>::try_from(plain.0.as_slice()).ok()?);
                if KemKeyPair::from_secret(seed.expose()).pk != public {
                    return None;
                }
                (seed, public, salt, body.clone())
            }
            _ => return None,
        };
        let wrapped = cbor::encode(&Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), Cbor::Bytes(scope)),
            (Cbor::Uint(2), Cbor::Bytes(public.to_vec())),
            (Cbor::Uint(3), Cbor::Bytes(salt.to_vec())),
            (Cbor::Uint(4), Cbor::Bytes(body)),
        ]))
        .ok()?;
        let result = cbor::encode(&Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Bytes(self.sign_pk.to_vec())),
            (Cbor::Uint(1), Cbor::Bytes(self.kem_pk.to_vec())),
            (Cbor::Uint(2), Cbor::Bytes(public.to_vec())),
            (Cbor::Uint(3), Cbor::Bytes(wrapped)),
        ]))
        .ok()?;
        self.active = Some(Active {
            connector,
            installation,
            seed,
            public,
        });
        // Final scope-specific wrap key is dropped here, root on retirement.
        Some(result)
    }
    fn aad(&self, scope: &[u8], public: &[u8; 32]) -> Option<Vec<u8>> {
        cbor::encode(&Cbor::Array(vec![
            Cbor::Text("mdbase/v1/app-noise-custody".into()),
            Cbor::Bytes(scope.to_vec()),
            Cbor::Bytes(self.sign_pk.to_vec()),
            Cbor::Bytes(self.kem_pk.to_vec()),
            Cbor::Bytes(public.to_vec()),
        ]))
        .ok()
    }
    pub(super) fn public_tuple(
        &self,
        connector: Uuid,
        device: Uuid,
        sign_pk: &[u8; 32],
    ) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
        let a = self.active.as_ref()?;
        if a.connector != connector
            || self.device != device
            || self.sign_pk != *sign_pk
            || a.installation.0 == [0; 16]
            || KemKeyPair::from_secret(a.seed.expose()).pk != a.public
        {
            return None;
        }
        Some((self.sign_pk, self.kem_pk, a.public))
    }
}
