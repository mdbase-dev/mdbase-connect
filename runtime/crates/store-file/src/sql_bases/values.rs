//! Consume the existing raw CBOR value grammar without intermediary wire values
//! or a full Core map. Unrequested fields are still validated, not ignored.
use super::*;
use mdbn_core::value::{Map, Value};
use mdbn_replica::store_query::RawField;

fn value(c: Cbor, retain: bool) -> StoreResult<Option<Value>> {
    Ok(match c {
        Cbor::Null => retain.then_some(Value::Null),
        Cbor::Bool(b) => retain.then_some(Value::Bool(b)),
        Cbor::Uint(_) | Cbor::Nint(_) => {
            let n = c.as_i64().ok_or_else(corrupt)?;
            retain.then_some(Value::Int(n))
        }
        Cbor::Float(f) => {
            let v = Value::float(f).ok_or_else(corrupt)?;
            retain.then_some(v)
        }
        Cbor::Text(s) => retain.then_some(Value::Text(s)),
        Cbor::Array(items) => {
            let mut out = if retain {
                Vec::with_capacity(items.len())
            } else {
                Vec::new()
            };
            for item in items {
                if let Some(v) = value(item, retain)? {
                    out.push(v);
                }
            }
            retain.then_some(Value::List(out))
        }
        Cbor::Map(items) => {
            let mut out = Map::new();
            for (key, item) in items {
                let Cbor::Text(key) = key else {
                    return Err(corrupt());
                };
                if let Some(v) = value(item, retain)? {
                    // Same insertion-order/last-value semantics as convert::map.
                    out.insert(key, v);
                }
            }
            retain.then_some(Value::Map(out))
        }
        Cbor::Bytes(_) => return Err(corrupt()),
    })
}

pub(super) fn fields(encoded: &[u8], names: &[String]) -> StoreResult<Vec<RawField>> {
    let Cbor::Map(items) = cbor::decode(encoded).map_err(|_| corrupt())? else {
        return Err(corrupt());
    };
    let mut out = vec![RawField::Missing; names.len()];
    for (key, item) in items {
        let Cbor::Text(key) = key else {
            return Err(corrupt());
        };
        let index = names.binary_search(&key).ok();
        if let Some(v) = value(item, index.is_some())? {
            out[index.expect("retained requested field")] = RawField::Present(v);
        }
    }
    Ok(out)
}

pub(super) fn tags(encoded: &[u8]) -> StoreResult<Option<Vec<String>>> {
    match cbor::decode(encoded).map_err(|_| corrupt())? {
        Cbor::Null => Ok(None),
        Cbor::Array(items) => items
            .into_iter()
            .map(|item| match item {
                Cbor::Text(s) => Ok(s),
                _ => Err(corrupt()),
            })
            .collect::<StoreResult<Vec<_>>>()
            .map(Some),
        _ => Err(corrupt()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::common::{DataMap, Value as WireValue};
    fn plain(fields: Vec<RawField>) -> Vec<Option<Value>> {
        fields
            .into_iter()
            .map(|field| match field {
                RawField::Missing => None,
                RawField::Present(value) => Some(value),
            })
            .collect()
    }
    #[test]
    fn consumed_projection_is_identical_to_existing_wire_and_core_conversion() {
        let cases = [
            "{}",
            "{null: null, flag: false, number: 12, float: 0.5, text: hi}",
            "{a: [null, false, 1, -2, 0.5, hi, {b: 2, a: 1}], z: ignored}",
            "{due: 2026-06-10, projects: ['[[Work|alias]]'], tags: [task]}",
        ];
        for source in cases {
            let map = mdbn_core::yaml::parse_value(source).unwrap().unwrap();
            let wire = convert::wmap(map.as_map().unwrap());
            let encoded = cbor::encode(&wire.to_cbor()).unwrap();
            let legacy = convert::map(
                &DataMap::<WireValue>::from_cbor(&cbor::decode(&encoded).unwrap()).unwrap(),
            )
            .unwrap();
            for names in [
                vec![String::from("a"), String::from("missing")],
                vec!["due".into(), "projects".into(), "tags".into()],
                vec![
                    "flag".into(),
                    "float".into(),
                    "null".into(),
                    "number".into(),
                    "text".into(),
                ],
            ] {
                let want: Vec<_> = names.iter().map(|name| legacy.get(name).cloned()).collect();
                assert_eq!(plain(fields(&encoded, &names).unwrap()), want);
            }
        }
    }
    #[test]
    fn unrequested_invalid_values_are_not_silently_discarded() {
        for c in [
            Cbor::Map(vec![(Cbor::Text("ignored".into()), Cbor::Bytes(vec![1]))]),
            Cbor::Map(vec![(
                Cbor::Text("ignored".into()),
                Cbor::Map(vec![(Cbor::Uint(1), Cbor::Null)]),
            )]),
            Cbor::Map(vec![(Cbor::Text("ignored".into()), Cbor::Uint(u64::MAX))]),
        ] {
            assert!(fields(&cbor::encode(&c).unwrap(), &["a".into()]).is_err());
        }
    }
    #[test]
    fn duplicate_keys_refuse_and_original_nested_map_order_is_preserved() {
        // Deliberately malformed raw bytes: {a:null,a:null}. The existing
        // decoder rejects duplicates before projection, even if unrequested.
        assert!(fields(&[0xa2, 0x61, b'a', 0xf6, 0x61, b'a', 0xf6], &["b".into()]).is_err());
        let c = Cbor::Map(vec![(
            Cbor::Text("a".into()),
            Cbor::Map(vec![
                (Cbor::Text("z".into()), Cbor::int(1)),
                (Cbor::Text("b".into()), Cbor::int(2)),
            ]),
        )]);
        let encoded = cbor::encode(&c).unwrap();
        let legacy = convert::map(
            &DataMap::<WireValue>::from_cbor(&cbor::decode(&encoded).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            plain(fields(&encoded, &["a".into()]).unwrap()),
            vec![legacy.get("a").cloned()]
        );
    }
    #[test]
    fn tags_keep_unknown_and_known_empty_distinct() {
        for tags in [
            None,
            Some(vec![]),
            Some(vec!["#task".into(), "#work/sub".into()]),
        ] {
            let c = tags.as_ref().map_or(Cbor::Null, Wire::to_cbor);
            assert_eq!(super::tags(&cbor::encode(&c).unwrap()).unwrap(), tags);
        }
        assert!(super::tags(&cbor::encode(&Cbor::Array(vec![Cbor::Null])).unwrap()).is_err());
    }
}
