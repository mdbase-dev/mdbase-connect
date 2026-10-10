//! Cross-bind the actual source header and actual successful FINISH receipt.
use crate::Refusal;
use crate::completion::{
    Completion, SMALL_FILE_MAX, Trust, collection, digest, exact_map, hash, small, uint,
};
use mdbn_log_service::{OfflineDecodeBudget, model::RetentionTier};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Uuid};
use mdbn_wire::schema::Wire;

pub(crate) struct Header {
    pub(crate) collection: Uuid,
    pub(crate) session: Uuid,
    pub(crate) head: u64,
    pub(crate) chain: B32,
    pub(crate) retained_from: u64,
    pub(crate) revision: u64,
    pub(crate) hash: B32,
}

impl Header {
    pub(crate) fn bind(
        raw: &[u8],
        raw_finish: &[u8],
        trust: &Trust,
        completion: &Completion,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        let result = Self::bind_checked(raw, raw_finish, trust, completion, work);
        if result.is_err() {
            crate::memory::poison(work);
        }
        result
    }

    fn bind_checked(
        raw: &[u8],
        raw_finish: &[u8],
        trust: &Trust,
        completion: &Completion,
        work: &OfflineDecodeBudget,
    ) -> Result<Self, Refusal> {
        if raw.len() > SMALL_FILE_MAX || raw_finish.len() > SMALL_FILE_MAX {
            return Err(Refusal::Bounds);
        }
        let header_hash = hash(raw, work)?;
        if header_hash != completion.header_hash
            || hash(raw_finish, work)? != completion.finish_hash
        {
            return Err(Refusal::Binding);
        }
        let value = small(raw, work)?;
        let fields = exact_map(&value, 11)?;
        if fields[0].1 != Cbor::Text("mdbase-next-backup/1".into())
            || fields[10].1 != Cbor::Text("rotate-url-secret-before-restored-traffic".into())
        {
            return Err(Refusal::Binding);
        }
        let collection = collection(&fields[1].1)?;
        let session = Uuid::from_cbor(&fields[2].1).map_err(|_| Refusal::Canonical)?;
        let head = uint(&fields[3].1)?;
        let chain = digest(&fields[4].1)?;
        let retained_from = uint(&fields[5].1)?;
        let revision = uint(&fields[6].1)?;
        if collection != trust.collection
            || head != completion.plan.head
            || chain != completion.plan.chain
            || retained_from != completion.plan.retained_from
            || uint(&fields[9].1)? != completion.plan.used_bytes
        {
            return Err(Refusal::Binding);
        }
        if revision == 0 || revision > (1 << 52) {
            return Err(Refusal::Bounds);
        }
        fields[8].1.as_i64().ok_or(Refusal::Canonical)?;
        // Authenticated expiry is source capture metadata, not current admission.
        match &fields[7].1 {
            Cbor::Array(settings) => match settings.as_slice() {
                [
                    Cbor::Uint(1),
                    Cbor::Array(quotas),
                    Cbor::Uint(days),
                    created,
                ] if RetentionTier::from_days(*days).is_some() => {
                    if quotas.len() != 4 {
                        return Err(Refusal::Canonical);
                    }
                    for quota in quotas {
                        uint(quota)?;
                    }
                    created.as_i64().ok_or(Refusal::Canonical)?;
                }
                _ => return Err(Refusal::Canonical),
            },
            _ => return Err(Refusal::Canonical),
        }
        let finish_value = small(raw_finish, work)?;
        let finish = exact_map(&finish_value, 8)?;
        if uint(&finish[0].1)? != 1
            || Uuid::from_cbor(&finish[1].1).map_err(|_| Refusal::Canonical)? != collection
            || Uuid::from_cbor(&finish[2].1).map_err(|_| Refusal::Canonical)? != session
            || uint(&finish[3].1)? != head
            || digest(&finish[4].1)? != chain
            || uint(&finish[5].1)? != revision
            || uint(&finish[6].1)? != completion.page_count
            || digest(&finish[7].1)? != completion.final_hash
        {
            return Err(Refusal::Binding);
        }
        Ok(Self {
            collection,
            session,
            head,
            chain,
            retained_from,
            revision,
            hash: header_hash,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::completion::tests::{fixture, signed};
    use mdbn_wire::cbor;
    use mdbn_wire::common::B16;
    use mdbn_wire::hash::sha256;

    fn source() -> (Cbor, Cbor) {
        let c = B16([0x31; 16]);
        let session = B16([0x71; 16]);
        let chain = B32([0x42; 32]);
        let header = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Text("mdbase-next-backup/1".into())),
            (Cbor::Uint(1), c.to_cbor()),
            (Cbor::Uint(2), session.to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(1)),
            (Cbor::Uint(4), chain.to_cbor()),
            (Cbor::Uint(5), Cbor::Uint(1)),
            (Cbor::Uint(6), Cbor::Uint(12)),
            (
                Cbor::Uint(7),
                Cbor::Array(vec![
                    Cbor::Uint(1),
                    Cbor::Array(vec![Cbor::Uint(1000); 4]),
                    Cbor::Uint(30),
                    Cbor::int(100),
                ]),
            ),
            (Cbor::Uint(8), Cbor::int(200)),
            (Cbor::Uint(9), Cbor::Uint(999)),
            (
                Cbor::Uint(10),
                Cbor::Text("rotate-url-secret-before-restored-traffic".into()),
            ),
        ]);
        let finish = Cbor::Map(vec![
            (Cbor::Uint(0), Cbor::Uint(1)),
            (Cbor::Uint(1), c.to_cbor()),
            (Cbor::Uint(2), session.to_cbor()),
            (Cbor::Uint(3), Cbor::Uint(1)),
            (Cbor::Uint(4), chain.to_cbor()),
            (Cbor::Uint(5), Cbor::Uint(12)),
            (Cbor::Uint(6), Cbor::Uint(6)),
            (Cbor::Uint(7), sha256(b"test-only-final-page").to_cbor()),
        ]);
        (header, finish)
    }

    fn bind(header: &Cbor, finish: &Cbor) -> Result<Header, Refusal> {
        let (trust, mut completion) = fixture();
        let raw = cbor::encode(header).unwrap();
        let raw_finish = cbor::encode(finish).unwrap();
        let Cbor::Map(fields) = &mut completion else {
            unreachable!()
        };
        fields[4].1 = sha256(&raw).to_cbor();
        fields[11].1 = sha256(&raw_finish).to_cbor();
        let work = OfflineDecodeBudget::new();
        let trust = Trust::parse(&cbor::encode(&trust).unwrap(), &work).unwrap();
        let completion =
            Completion::authenticate(&cbor::encode(&signed(completion)).unwrap(), &trust, &work)
                .unwrap();
        Header::bind(&raw, &raw_finish, &trust, &completion, &work)
    }

    #[test]
    fn exact_finish_and_expired_historical_capture_bind_without_current_permit() {
        let (header, finish) = source();
        let value = bind(&header, &finish).unwrap();
        assert_eq!(value.collection, B16([0x31; 16]));
        assert_eq!(value.session, B16([0x71; 16]));
        assert_eq!(value.head, 1);
        assert_eq!(value.chain, B32([0x42; 32]));
        assert_eq!(value.retained_from, 1);
        assert_eq!(value.revision, 12);
        assert_eq!(value.hash, sha256(&cbor::encode(&header).unwrap()));
    }

    #[test]
    fn every_finish_binding_and_extra_field_refuse() {
        for field in 0..8 {
            let (header, mut finish) = source();
            let Cbor::Map(fields) = &mut finish else {
                unreachable!()
            };
            fields[field].1 = match field {
                1 | 2 => B16([0x91; 16]).to_cbor(),
                4 | 7 => B32([0x91; 32]).to_cbor(),
                _ => Cbor::Uint(99),
            };
            assert!(matches!(bind(&header, &finish), Err(Refusal::Binding)));
        }
        let (header, mut finish) = source();
        let Cbor::Map(fields) = &mut finish else {
            unreachable!()
        };
        fields.push((Cbor::Uint(8), Cbor::Null));
        assert!(matches!(bind(&header, &finish), Err(Refusal::Canonical)));
    }

    #[test]
    fn actual_header_plan_and_settings_must_match() {
        for field in [3, 5, 9] {
            let (mut header, finish) = source();
            let Cbor::Map(fields) = &mut header else {
                unreachable!()
            };
            fields[field].1 = Cbor::Uint(123);
            assert!(matches!(bind(&header, &finish), Err(Refusal::Binding)));
        }
        let (mut header, finish) = source();
        let Cbor::Map(fields) = &mut header else {
            unreachable!()
        };
        let Cbor::Array(settings) = &mut fields[7].1 else {
            unreachable!()
        };
        settings[2] = Cbor::Uint(29);
        assert!(matches!(bind(&header, &finish), Err(Refusal::Canonical)));
    }
}
