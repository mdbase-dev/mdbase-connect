//! Exact native completion authentication, before any bulk cut traversal.
use crate::Refusal;
use crate::memory::{Owned, poison, scratch};
use mdbn_log_service::{OfflineDecodeBudget, restore_plan::RestorePlan};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, B64, Uuid};
use mdbn_wire::hash::{h, sha256};
use mdbn_wire::schema::Wire;

pub(crate) const SMALL_FILE_MAX: usize = 64 * 1024;
pub(crate) const MAX_PAGES: u64 = 65_536;
pub(crate) const MAX_OBJECTS: u64 = 65_536;
pub(crate) const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub(crate) const MAX_PAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const DOMAIN: &str = "mdbase/v1/native-backup-completion";

/// Parsed only from the independently authenticated, caller-frozen trust input.
/// Never assembled from a header, policy replay or completion-provided key.
pub(crate) struct Trust {
    pub(crate) environment: String,
    pub(crate) collection: Uuid,
    pub(crate) signer: B32,
    pub(crate) roots: Vec<B32>,
    pub(crate) capture_context: B32,
    pub(crate) genesis: B32,
    _allocation: mdbn_log_service::OfflineOwnedReservation,
}

/// An authenticated capture assertion, not a live permission or verified cut.
pub(crate) struct Completion {
    pub(crate) header_hash: B32,
    pub(crate) page_count: u64,
    pub(crate) final_hash: B32,
    pub(crate) plan: RestorePlan,
    pub(crate) object_count: u64,
    pub(crate) object_bytes: u64,
    pub(crate) finish_hash: B32,
}

pub(crate) fn hash(raw: &[u8], work: &OfflineDecodeBudget) -> Result<B32, Refusal> {
    work.request().preflight(raw).map_err(|error| {
        if error.reason == "cbor_shape" {
            Refusal::Canonical
        } else {
            Refusal::Bounds
        }
    })?;
    Ok(sha256(raw))
}

pub(crate) fn small(raw: &[u8], work: &OfflineDecodeBudget) -> Result<Owned<Cbor>, Refusal> {
    if raw.len() > SMALL_FILE_MAX {
        poison(work);
        return Err(Refusal::Bounds);
    }
    Owned::construct(work, scratch(raw.len())?, || {
        work.request().raw(raw).map_err(|error| {
            if matches!(error.reason.as_deref(), Some("shape" | "cbor_shape")) {
                Refusal::Canonical
            } else {
                Refusal::Bounds
            }
        })
    })
}

pub(crate) fn exact_map(value: &Cbor, count: usize) -> Result<&[(Cbor, Cbor)], Refusal> {
    let Cbor::Map(fields) = value else {
        return Err(Refusal::Canonical);
    };
    if fields.len() != count
        || fields
            .iter()
            .enumerate()
            .any(|(key, (actual, _))| *actual != Cbor::Uint(key as u64))
    {
        return Err(Refusal::Canonical);
    }
    Ok(fields)
}

fn text(value: &Cbor) -> Result<&str, Refusal> {
    match value {
        Cbor::Text(text) => Ok(text),
        _ => Err(Refusal::Canonical),
    }
}

pub(crate) fn uint(value: &Cbor) -> Result<u64, Refusal> {
    match value {
        Cbor::Uint(value) => Ok(*value),
        _ => Err(Refusal::Canonical),
    }
}

pub(crate) fn digest(value: &Cbor) -> Result<B32, Refusal> {
    B32::from_cbor(value).map_err(|_| Refusal::Canonical)
}

pub(crate) fn collection(value: &Cbor) -> Result<Uuid, Refusal> {
    let collection = Uuid::from_cbor(value).map_err(|_| Refusal::Canonical)?;
    if collection == B16([0; 16]) {
        return Err(Refusal::Trust);
    }
    Ok(collection)
}

impl Trust {
    pub(crate) fn parse(raw: &[u8], work: &OfflineDecodeBudget) -> Result<Self, Refusal> {
        let result = Self::parse_checked(raw, work);
        if result.is_err() {
            poison(work);
        }
        result
    }

    fn parse_checked(raw: &[u8], work: &OfflineDecodeBudget) -> Result<Self, Refusal> {
        let value = small(raw, work)?;
        let fields = exact_map(&value, 8)?;
        if text(&fields[0].1)? != "mdbase-native-backup-trust/1"
            || text(&fields[1].1)? != "backup-completion"
        {
            return Err(Refusal::Trust);
        }
        let Cbor::Array(roots) = &fields[5].1 else {
            return Err(Refusal::Canonical);
        };
        if roots.is_empty() || roots.len() > 32 {
            return Err(Refusal::Bounds);
        }
        let allocation = work
            .reserve_owned(2 * SMALL_FILE_MAX as u64 + 4096)
            .map_err(|_| Refusal::Bounds)?;
        let mut pins = Vec::with_capacity(roots.len());
        for root in roots {
            let root = digest(root)?;
            if pins.contains(&root) {
                return Err(Refusal::Trust);
            }
            pins.push(root);
        }
        Ok(Self {
            environment: text(&fields[2].1)?.to_owned(),
            collection: collection(&fields[3].1)?,
            signer: digest(&fields[4].1)?,
            roots: pins,
            capture_context: digest(&fields[6].1)?,
            genesis: digest(&fields[7].1)?,
            _allocation: allocation,
        })
    }
}

impl Completion {
    pub(crate) fn authenticate(
        raw: &[u8],
        trust: &Trust,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let result = Self::authenticate_checked(raw, trust, work);
        if result.is_err() {
            poison(work);
        }
        result
    }

    fn authenticate_checked(
        raw: &[u8],
        trust: &Trust,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let value = small(raw, work)?;
        let fields = exact_map(&value, 13)?;
        if text(&fields[0].1)? != "mdbase-native-backup-completion/1"
            || text(&fields[1].1)? != "backup-completion"
            || text(&fields[2].1)? != trust.environment
            || collection(&fields[3].1)? != trust.collection
            || digest(&fields[10].1)? != trust.capture_context
        {
            return Err(Refusal::Trust);
        }
        let signature = B64::from_cbor(&fields[12].1).map_err(|_| Refusal::Canonical)?;
        let unsigned =
            cbor::encode(&Cbor::Map(fields[..12].to_vec())).map_err(|_| Refusal::Canonical)?;
        work.request()
            .preflight(&unsigned)
            .map_err(|_| Refusal::Bounds)?;
        let message = h(DOMAIN, &unsigned);
        if !mdbn_log_service::auth::verify_sig(&trust.signer.0, &message.0, &signature.0) {
            return Err(Refusal::Signature);
        }
        let plan_fields = match &fields[7].1 {
            Cbor::Array(values) if values.len() == 8 => values,
            _ => return Err(Refusal::Canonical),
        };
        // Keep checked-u64 overflow a resource refusal, not a shape failure.
        uint(&plan_fields[2])?
            .checked_add(1)
            .ok_or(Refusal::Bounds)?;
        let plan = RestorePlan::parse(&fields[7].1).map_err(|_| Refusal::Canonical)?;
        let page_count = uint(&fields[5].1)?;
        let object_count = uint(&fields[8].1)?;
        let object_bytes = uint(&fields[9].1)?;
        if !(6..=MAX_PAGES).contains(&page_count)
            || object_count > MAX_OBJECTS
            || object_bytes > MAX_OBJECT_BYTES
            || plan.used_bytes > MAX_OBJECT_BYTES + MAX_PAGE_BYTES
        {
            return Err(Refusal::Bounds);
        }
        Ok(Self {
            header_hash: digest(&fields[4].1)?,
            page_count,
            final_hash: digest(&fields[6].1)?,
            plan,
            object_count,
            object_bytes,
            finish_hash: digest(&fields[11].1)?,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use mdbn_log_service::testkit::{key, sign_digest};
    use mdbn_wire::hash::sha256;

    pub(crate) fn fixture() -> (Cbor, Cbor) {
        let signer = key(b"offline/test-only/completion-signer");
        let c = B16([0x31; 16]);
        let context = sha256(b"offline/test-only/capture-context");
        let trust = Cbor::Map(vec![
            (
                Cbor::Uint(0),
                Cbor::Text("mdbase-native-backup-trust/1".into()),
            ),
            (Cbor::Uint(1), Cbor::Text("backup-completion".into())),
            (Cbor::Uint(2), Cbor::Text("offline-test".into())),
            (Cbor::Uint(3), c.to_cbor()),
            (
                Cbor::Uint(4),
                B32(signer.verifying_key().to_bytes()).to_cbor(),
            ),
            (Cbor::Uint(5), Cbor::Array(vec![B32([0x21; 32]).to_cbor()])),
            (Cbor::Uint(6), context.to_cbor()),
            (Cbor::Uint(7), sha256(b"test-only-genesis").to_cbor()),
        ]);
        let completion = Cbor::Map(vec![
            (
                Cbor::Uint(0),
                Cbor::Text("mdbase-native-backup-completion/1".into()),
            ),
            (Cbor::Uint(1), Cbor::Text("backup-completion".into())),
            (Cbor::Uint(2), Cbor::Text("offline-test".into())),
            (Cbor::Uint(3), c.to_cbor()),
            (Cbor::Uint(4), sha256(b"test-only-header").to_cbor()),
            (Cbor::Uint(5), Cbor::Uint(6)),
            (Cbor::Uint(6), sha256(b"test-only-final-page").to_cbor()),
            (
                Cbor::Uint(7),
                Cbor::Array(vec![
                    Cbor::Uint(1),
                    Cbor::Uint(999),
                    Cbor::Uint(1),
                    B32([0x42; 32]).to_cbor(),
                    Cbor::Uint(1),
                    B32([0x43; 32]).to_cbor(),
                    B32([0x44; 32]).to_cbor(),
                    B32([0x45; 32]).to_cbor(),
                ]),
            ),
            (Cbor::Uint(8), Cbor::Uint(1)),
            (Cbor::Uint(9), Cbor::Uint(100)),
            (Cbor::Uint(10), context.to_cbor()),
            (Cbor::Uint(11), sha256(b"test-only-finish").to_cbor()),
        ]);
        (trust, signed(completion))
    }

    pub(crate) fn signed(mut value: Cbor) -> Cbor {
        let Cbor::Map(fields) = &mut value else {
            unreachable!()
        };
        fields.retain(|(key, _)| *key != Cbor::Uint(12));
        let bytes = cbor::encode(&Cbor::Map(fields.clone())).unwrap();
        let signature = sign_digest(
            &key(b"offline/test-only/completion-signer"),
            &h(DOMAIN, &bytes),
        );
        fields.push((Cbor::Uint(12), signature.to_cbor()));
        value
    }

    fn authenticate(trust: &Cbor, completion: &Cbor) -> Result<Completion, Refusal> {
        let work = OfflineDecodeBudget::new();
        let trust = Trust::parse(&cbor::encode(trust).unwrap(), &work)?;
        Completion::authenticate(&cbor::encode(completion).unwrap(), &trust, &work)
    }

    #[test]
    fn independent_sdk_node_canonical_hash_signature_golden() {
        let vector = include_str!("../tests/vectors/completion-v1.txt");
        let bytes = |field: &str| {
            let hex = vector
                .lines()
                .find_map(|line| {
                    let (name, hex) = line.split_once('=')?;
                    (name == field).then_some(hex)
                })
                .unwrap();
            assert_eq!(hex.len() % 2, 0);
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect::<Vec<_>>()
        };
        let (trust, completion) = fixture();
        assert_eq!(cbor::encode(&trust).unwrap(), bytes("trust"));
        assert_eq!(cbor::encode(&completion).unwrap(), bytes("completion"));
        let Cbor::Map(fields) = completion else {
            unreachable!()
        };
        let unsigned = cbor::encode(&Cbor::Map(fields[..12].to_vec())).unwrap();
        assert_eq!(unsigned, bytes("unsigned"));
        assert_eq!(h(DOMAIN, &unsigned).0.as_slice(), bytes("domain_digest"));
        assert_eq!(
            B64::from_cbor(&fields[12].1).unwrap().0.as_slice(),
            bytes("signature")
        );
        let work = OfflineDecodeBudget::new();
        let trust = Trust::parse(&bytes("trust"), &work).unwrap();
        assert_eq!(trust.signer.0.as_slice(), bytes("public_key"));
        assert_eq!(trust.roots, vec![B32([0x21; 32])]);
        assert_eq!(trust.genesis, sha256(b"test-only-genesis"));
        Completion::authenticate(&bytes("completion"), &trust, &work).unwrap();
    }

    #[test]
    fn independently_pinned_completion_authenticates_capture_only() {
        let (trust, completion) = fixture();
        let verified = authenticate(&trust, &completion).unwrap();
        assert_eq!(verified.page_count, 6);
        assert_eq!(verified.object_count, 1);
        assert_eq!(verified.object_bytes, 100);
        assert_eq!(verified.plan.used_bytes, 999);
        assert_eq!(verified.header_hash, sha256(b"test-only-header"));
        assert_eq!(verified.finish_hash, sha256(b"test-only-finish"));
        assert_eq!(verified.final_hash, sha256(b"test-only-final-page"));
    }

    #[test]
    fn trust_scope_and_signature_substitutions_refuse() {
        for (field, value) in [
            (1, Cbor::Text("other-purpose".into())),
            (2, Cbor::Text("other-environment".into())),
            (3, B16([0x32; 16]).to_cbor()),
            (3, B16([0; 16]).to_cbor()),
            (10, B32([0x99; 32]).to_cbor()),
        ] {
            let (trust, mut completion) = fixture();
            let Cbor::Map(fields) = &mut completion else {
                unreachable!()
            };
            fields[field].1 = value;
            assert!(matches!(
                authenticate(&trust, &signed(completion)),
                Err(Refusal::Trust)
            ));
        }
        let (mut trust, completion) = fixture();
        let Cbor::Map(fields) = &mut trust else {
            unreachable!()
        };
        fields[4].1 = B32(key(b"another-test-only-signer").verifying_key().to_bytes()).to_cbor();
        assert!(matches!(
            authenticate(&trust, &completion),
            Err(Refusal::Signature)
        ));
    }

    #[test]
    fn exact_maps_input_limits_and_unsigned_mutation_refuse() {
        let (trust, mut completion) = fixture();
        if let Cbor::Map(fields) = &mut completion {
            fields[4].1 = B32([0x99; 32]).to_cbor();
        }
        assert!(matches!(
            authenticate(&trust, &completion),
            Err(Refusal::Signature)
        ));
        if let Cbor::Map(fields) = &mut completion {
            fields.push((Cbor::Uint(13), Cbor::Null));
        }
        assert!(matches!(
            authenticate(&trust, &completion),
            Err(Refusal::Canonical)
        ));
        assert!(matches!(
            small(&vec![0; SMALL_FILE_MAX + 1], &OfflineDecodeBudget::new()),
            Err(Refusal::Bounds)
        ));
        let work = OfflineDecodeBudget::new();
        assert!(matches!(
            Trust::parse(&[0xf6, 0xf6], &work),
            Err(Refusal::Canonical)
        ));
        assert!(work.request().raw(&[0xf6]).is_err());
    }

    #[test]
    fn authenticated_counts_and_overflow_refuse_explicitly() {
        for (field, count) in [
            (5, 5),
            (5, MAX_PAGES + 1),
            (8, MAX_OBJECTS + 1),
            (9, MAX_OBJECT_BYTES + 1),
        ] {
            let (trust, mut completion) = fixture();
            let Cbor::Map(fields) = &mut completion else {
                unreachable!()
            };
            fields[field].1 = Cbor::Uint(count);
            assert!(matches!(
                authenticate(&trust, &signed(completion)),
                Err(Refusal::Bounds)
            ));
        }
        let (trust, mut completion) = fixture();
        let Cbor::Map(fields) = &mut completion else {
            unreachable!()
        };
        let Cbor::Array(plan) = &mut fields[7].1 else {
            unreachable!()
        };
        plan[2] = Cbor::Uint(u64::MAX);
        assert!(matches!(
            authenticate(&trust, &signed(completion)),
            Err(Refusal::Bounds)
        ));
    }
}
