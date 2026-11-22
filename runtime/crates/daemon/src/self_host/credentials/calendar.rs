//! The owner-only grant database also owns this collection's preissued TLS leaves.

use std::collections::BTreeSet;
use std::net::IpAddr;

use mdbn_wire::hash::sha256;
use mdbn_wire::render::hex;
use ring::signature::{self, KeyPair};
use rusqlite::{Transaction, TransactionBehavior, params};
use time::OffsetDateTime;
use x509_parser::oid_registry::{
    OID_EC_P256, OID_KEY_TYPE_EC_PUBLIC_KEY, OID_SIG_ECDSA_WITH_SHA256,
};
use zeroize::Zeroizing;

use super::{Credentials, Result};

pub(in super::super) const SLOT_SECONDS: i64 = 12 * 24 * 3600;
const COUNT: usize = 32;

pub(in super::super) fn slot_at(seconds: i64) -> i64 {
    seconds.div_euclid(SLOT_SECONDS)
}

pub(in super::super) fn current_slot() -> i64 {
    slot_at(OffsetDateTime::now_utc().unix_timestamp())
}

fn validity(slot: i64) -> Result<(OffsetDateTime, OffsetDateTime)> {
    let start = slot.checked_mul(SLOT_SECONDS).ok_or("invalid TLS slot")?;
    Ok((
        OffsetDateTime::from_unix_timestamp(start.checked_sub(3600).ok_or("invalid TLS slot")?)?,
        OffsetDateTime::from_unix_timestamp(
            start
                .checked_add(SLOT_SECONDS + 3600)
                .ok_or("invalid TLS slot")?,
        )?,
    ))
}

pub(in super::super) struct Pins {
    pub(in super::super) first: i64,
    hashes: Vec<[u8; 32]>,
}

impl Pins {
    pub(in super::super) fn current_pin(&self) -> String {
        hex(&self.hashes[0])
    }

    pub(in super::super) fn capability(&self, bearer: &str) -> String {
        let mut response = format!("WTP1.{bearer}.{}", self.first);
        for hash in &self.hashes {
            response.push('.');
            response.push_str(&hex(hash));
        }
        response
    }

    pub(super) fn verify_for_pairing(&self, tx: &Transaction<'_>, current: i64) -> Result<()> {
        if current != self.first {
            return Err("WebTransport slot changed; reconnect to pair".into());
        }
        let saved = read_calendar(tx)?;
        if saved.first != self.first || saved.hashes != self.hashes {
            return Err("WebTransport calendar changed; reconnect to pair".into());
        }
        Ok(())
    }
}

pub(in super::super) struct Leaf {
    pub(in super::super) cert: Vec<u8>,
    pub(in super::super) key: Zeroizing<Vec<u8>>,
}

impl Leaf {
    fn generate(ip: IpAddr, slot: i64) -> Result<Self> {
        let (start, end) = validity(slot)?;
        let identity = wtransport::Identity::self_signed_builder()
            .subject_alt_names([ip.to_string()])
            .validity_period(start, end)
            .build()?;
        Ok(Self {
            cert: identity.certificate_chain().as_slice()[0].der().to_vec(),
            key: Zeroizing::new(identity.private_key().secret_der().to_vec()),
        })
    }

    fn validate(&self, slot: i64) -> Result<Vec<u8>> {
        let (rest, cert) = x509_parser::parse_x509_certificate(&self.cert)
            .map_err(|_| "invalid stored WebTransport certificate")?;
        let (start, end) = validity(slot)?;
        let public = cert.public_key();
        let signer = signature::EcdsaKeyPair::from_pkcs8(
            &signature::ECDSA_P256_SHA256_ASN1_SIGNING,
            &self.key,
            &ring::rand::SystemRandom::new(),
        )
        .map_err(|_| "invalid stored WebTransport key")?;
        if !rest.is_empty()
            || cert.validity().not_before.to_datetime() != start
            || cert.validity().not_after.to_datetime() != end
            || cert.subject() != cert.issuer()
            || cert.is_ca()
            || cert.signature != cert.signature_algorithm
            || cert.signature_algorithm.algorithm != OID_SIG_ECDSA_WITH_SHA256
            || public.algorithm.algorithm != OID_KEY_TYPE_EC_PUBLIC_KEY
            || !matches!(public.algorithm.parameters.as_ref().map(|p| p.as_oid()), Some(Ok(curve)) if curve == OID_EC_P256)
            || public.subject_public_key.data.as_ref() != signer.public_key().as_ref()
        {
            return Err("invalid stored WebTransport leaf for slot".into());
        }
        signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_ASN1, signer.public_key())
            .verify(cert.tbs_certificate.as_ref(), &cert.signature_value.data)
            .map_err(|_| "invalid stored WebTransport self-signature")?;
        Ok(signer.public_key().as_ref().to_vec())
    }
}

// The manifest commits to the ordered DER hashes issued to browsers. Validate the
// entire old window before pruning or extending it, including on large clock jumps.
fn read_calendar(tx: &Transaction<'_>) -> Result<Pins> {
    let (first, manifest): (i64, Vec<u8>) =
        tx.query_row("SELECT first,pins FROM webtransport_calendar", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    if manifest.len() != COUNT * 32 {
        return Err("WebTransport calendar integrity check failed".into());
    }
    let mut stmt =
        tx.prepare("SELECT slot,cert,key FROM webtransport_leaf ORDER BY slot LIMIT 33")?;
    let mut rows = stmt.query([])?;
    let mut hashes = Vec::with_capacity(COUNT);
    let mut public_keys = BTreeSet::new();
    while let Some(row) = rows.next()? {
        let slot: i64 = row.get(0)?;
        if hashes.len() >= COUNT || Some(slot) != first.checked_add(hashes.len() as i64) {
            return Err("incomplete WebTransport calendar".into());
        }
        let leaf = Leaf {
            cert: row.get(1)?,
            key: Zeroizing::new(row.get(2)?),
        };
        let hash = sha256(&leaf.cert).0;
        if hash != manifest[hashes.len() * 32..(hashes.len() + 1) * 32]
            || !public_keys.insert(leaf.validate(slot)?)
        {
            return Err("WebTransport calendar integrity check failed".into());
        }
        hashes.push(hash);
    }
    if hashes.len() != COUNT {
        return Err("incomplete WebTransport calendar".into());
    }
    Ok(Pins { first, hashes })
}

impl Credentials {
    pub(in super::super) fn transport_calendar(
        &self,
        ip: IpAddr,
        first: i64,
    ) -> Result<(Leaf, Pins)> {
        let mut db = self.db()?;
        // Pruned private keys should leave neither a live row nor their original
        // bytes in SQLite's free space.
        db.pragma_update(None, "secure_delete", true)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // A store that has only served the WSS gateway has no calendar yet. A leaf
        // without its manifest is damage, never a reason to issue new pins.
        let issued: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM webtransport_calendar) OR EXISTS(SELECT 1 FROM webtransport_leaf)",
            [],
            |r| r.get(0),
        )?;
        let mut hashes = if issued {
            let saved = read_calendar(&tx)?;
            if first < saved.first {
                return Err("clock precedes retained WebTransport calendar".into());
            }
            tx.execute("DELETE FROM webtransport_leaf WHERE slot < ?1", [first])?;
            saved
                .hashes
                .into_iter()
                .skip(first.abs_diff(saved.first).min(COUNT as u64) as usize)
                .collect()
        } else {
            Vec::new()
        };
        if hashes.len() < COUNT {
            for offset in hashes.len()..COUNT {
                let slot = first.checked_add(offset as i64).ok_or("invalid TLS slot")?;
                let leaf = Leaf::generate(ip, slot)?;
                tx.execute(
                    "INSERT INTO webtransport_leaf VALUES(?1,?2,?3)",
                    params![slot, leaf.cert, leaf.key.as_slice()],
                )?;
                hashes.push(sha256(&leaf.cert).0);
            }
            tx.execute(
                "INSERT OR REPLACE INTO webtransport_calendar VALUES(1,?1,?2)",
                params![first, hashes.as_flattened()],
            )?;
        }
        let leaf = tx.query_row(
            "SELECT cert,key FROM webtransport_leaf WHERE slot=?1",
            [first],
            |r| {
                Ok(Leaf {
                    cert: r.get(0)?,
                    key: Zeroizing::new(r.get(1)?),
                })
            },
        )?;
        tx.commit()?;
        Ok((leaf, Pins { first, hashes }))
    }
}

#[cfg(test)]
mod tests;
