//! Thin JSON-to-Core installer bridge. Core owns pack/configuration semantics.
use super::{DeclaredSetupEvidence, invalid};
use crate::attest::AttestError;
use mdbn_core::{
    packs::{AssessOptions, load_pack},
    setup::envelope::{CollectionSetup, CollectionSetupTypePack},
    value::{Map, Value},
};
use std::collections::BTreeMap;

fn value(v: &serde_json::Value) -> Result<Value, AttestError> {
    Ok(match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(v) => Value::Bool(*v),
        serde_json::Value::String(v) => Value::Text(v.clone()),
        serde_json::Value::Number(v) => match v.as_i64() {
            Some(v) => Value::Int(v),
            None => Value::Float(v.as_f64().filter(|v| v.is_finite()).ok_or_else(invalid)?),
        },
        serde_json::Value::Array(v) => Value::List(v.iter().map(value).collect::<Result<_, _>>()?),
        serde_json::Value::Object(v) => {
            let mut map = Map::new();
            for (k, v) in v {
                map.insert(k, value(v)?);
            }
            Value::Map(map)
        }
    })
}
impl DeclaredSetupEvidence {
    /// Load only the retained declaration, through Core's strict setup/pack
    /// bridge. No request-provided manifest, source document, path or authority.
    pub fn core_setup(&self) -> Result<CollectionSetup, AttestError> {
        let mut projection = self.projection();
        let packs = projection["provisions"]["type_packs"]
            .as_array_mut()
            .ok_or_else(invalid)?;
        for pack in packs {
            *pack = serde_json::json!({
                "provision": pack.clone(),
                "options": {"installed_by": self.application_id()}
            });
        }
        let load =
            |entry: &Value| -> Result<CollectionSetupTypePack, Box<mdbn_core::validate::Issue>> {
                let bad = || {
                    Box::new(mdbn_core::validate::Issue::new(
                        "invalid_collection_setup",
                        mdbn_core::validate::Severity::Error,
                        mdbn_core::validate::Tier::Request,
                        "invalid declared setup pack",
                    ))
                };
                let provision = entry
                    .as_map()
                    .and_then(|v| v.get("provision"))
                    .and_then(Value::as_map)
                    .ok_or_else(bad)?;
                let manifest = provision
                    .get("manifest")
                    .and_then(Value::as_map)
                    .ok_or_else(bad)?;
                let resources = provision
                    .get("resources")
                    .and_then(Value::as_list)
                    .ok_or_else(bad)?;
                let mut sources = BTreeMap::new();
                for resource in resources {
                    let row = resource.as_map().ok_or_else(bad)?;
                    if row.len() != 2 {
                        return Err(bad());
                    }
                    let path = row.get("source").and_then(Value::as_str).ok_or_else(bad)?;
                    let document = row
                        .get("document")
                        .and_then(Value::as_str)
                        .ok_or_else(bad)?;
                    if sources
                        .insert(path.to_owned(), document.to_owned())
                        .is_some()
                    {
                        return Err(bad());
                    }
                }
                let pack = load_pack(&Value::Map(manifest.clone()).to_json(), &|p| {
                    sources.get(p).cloned()
                })
                .map_err(Box::new)?;
                if pack.resources.len() != sources.len() {
                    return Err(bad());
                }
                Ok(CollectionSetupTypePack {
                    pack,
                    options: AssessOptions {
                        installed_by: self.application_id().into(),
                        ..Default::default()
                    },
                })
            };
        CollectionSetup::from_value(&value(&projection)?, &load).map_err(|_| invalid())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_core::{
        ids::{FileId, Hash},
        intent::{Op, OpClock},
        setup::{
            capture::{SetupSourceObservation, SetupStateView},
            envelope::{apply_collection_setup, assess_collection_setup},
        },
        state::{MemState, StateView, StoredFile},
        validate::Issue,
    };

    struct Empty(MemState);
    impl SetupStateView for Empty {
        fn state(&self) -> &dyn StateView {
            &self.0
        }
        fn collection_revision(&self) -> Hash {
            Hash::of(b"empty Reader collection")
        }
        fn file_page(&self, _: Option<FileId>, _: usize) -> Result<Vec<StoredFile>, Box<Issue>> {
            Ok(vec![])
        }
        fn source(&self, _: &StoredFile, _: usize) -> Result<SetupSourceObservation, Box<Issue>> {
            panic!("empty inventory cannot request a source")
        }
    }

    #[test]
    fn fresh_reader_public_declaration_is_applicable_without_existing_resources() {
        // Canonical shared-parser output of the complete public LAB declaration,
        // not a reduced Journal-shaped pack or hand-added configuration.
        let declaration: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/sdk/test/fixtures/reader-app.json"
        ))
        .unwrap();
        let evidence = DeclaredSetupEvidence {
            application_id: declaration["id"].as_str().unwrap().into(),
            digest: format!(
                "sha256:{:x}",
                <sha2::Sha256 as sha2::Digest>::digest(serde_json::to_vec(&declaration).unwrap())
            ),
            declaration,
            operations: vec![
                "assess_collection_setup".into(),
                "apply_collection_setup".into(),
            ],
            authorization_binding_digest: "synthetic pure installer test".into(),
        };
        let setup = evidence.core_setup().unwrap();
        let clock = OpClock {
            instant_ms: 0,
            tz: "UTC".into(),
            local_date: "1970-01-01".into(),
        };
        let empty = Empty(MemState::new());
        assert_eq!(setup.type_packs.len(), 2);
        let assessed = assess_collection_setup(&empty, &setup, &clock).unwrap();
        assert!(assessed.applicable, "fresh Reader must be provisionable");
        let (_, operations) = apply_collection_setup(
            &empty,
            &setup,
            &clock,
            assessed.collection_revision,
            assessed.assessment_digest,
        )
        .unwrap();
        let locks: Vec<_> = operations
            .iter()
            .filter_map(|op| match op {
                Op::ResourcePut(row) if row.path == mdbn_core::types::LOCK_PATH => Some(row),
                _ => None,
            })
            .collect();
        assert_eq!(
            locks.len(),
            1,
            "both packs share one original guarded lock write"
        );
        assert!(locks[0].must_not_exist && locks[0].base_revision.is_none());
        assert!(locks[0].doc.contains("dev.mdbase.reader") && locks[0].doc.contains("mdbase.view"));
    }
}
