//! Read and deliberately edit the collection's config through its replica.

use mdbn_core::cel::time::tzdb::NamedZone;
use mdbn_core::doc::{Document, RecordFormat};
use mdbn_core::types::{CONFIG_PATH, is_plausible_iana_zone};
use mdbn_core::value::{Map, Value as Yaml};
use mdbn_core::writer::{self, Change};
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{Receipt, ReceiptState, SubmitParams, WaitFor};
use mdbn_wire::common::{Hash, Text};
use mdbn_wire::intent::{Op, ResourcePut};

use super::*;

impl Daemon {
    pub(super) async fn collection_timezone(
        &self,
        p: CollectionTimezone,
    ) -> Result<Value, ControlError> {
        let rt = self.runtime_of(&p.collection).await?;
        let stored = read_collection_config(&rt).await?;
        let detected = mdbn_local_host::SystemZones::detected_machine_zone();
        let timezone = match p.timezone {
            Some(zone) => {
                if !is_plausible_iana_zone(&zone) || NamedZone::get(&zone).is_err() {
                    return Err(ControlError::invalid(
                        "invalid_timezone",
                        "Enter a valid IANA time zone.",
                    ));
                }
                let (source, revision) = match stored {
                    Some((source, revision)) => (source, Some(revision)),
                    None => (config_for_existing_folder(None), None),
                };
                let doc = Document::parse(source, RecordFormat::YamlDocument);
                let settings = config_settings(&doc)?;
                if revision.is_none()
                    || settings.get("timezone").and_then(Yaml::as_str) != Some(&zone)
                {
                    let updated = with_timezone(&doc, settings, &zone).map_err(|_| {
                        ControlError::invalid("invalid_config", "Could not update mdbase.yaml.")
                    })?;
                    put_collection_config(&rt, updated, revision).await?;
                }
                Some(zone)
            }
            None => match stored {
                Some((source, _)) => {
                    let doc = Document::parse(source, RecordFormat::YamlDocument);
                    config_settings(&doc)?
                        .get("timezone")
                        .and_then(Yaml::as_str)
                        .map(str::to_owned)
                }
                None => None,
            },
        };
        Ok(json!({ "timezone": timezone, "detected_timezone": detected }))
    }
}

fn config_settings(doc: &Document) -> Result<Map, ControlError> {
    if doc.problem().is_some() {
        return Err(ControlError::invalid(
            "invalid_config",
            "mdbase.yaml must be a valid YAML mapping.",
        ));
    }
    match doc.frontmatter().get("settings") {
        Some(Yaml::Map(settings)) => Ok(settings.clone()),
        None => Ok(Map::new()),
        _ => Err(ControlError::invalid(
            "invalid_config",
            "mdbase.yaml settings must be a mapping.",
        )),
    }
}

fn with_timezone(
    doc: &Document,
    mut settings: Map,
    zone: &str,
) -> Result<String, writer::WriteError> {
    let old = settings.clone();
    settings.insert("timezone", Yaml::string(zone));
    // Reuse the writer on the settings block itself so unrelated settings keep
    // their formatting and comments. Flow mappings and cross-entry anchors
    // use the writer's normal verified mapping update.
    if let Some(entry) = writer::entry_copy(doc, "settings")
        && let Some((header, body)) = entry.text().split_once('\n')
        && let Some(start) = doc.source().find(entry.text())
    {
        let nested = Document::parse(body, RecordFormat::YamlDocument);
        if !old.is_empty() && nested.problem().is_none() && *nested.frontmatter() == old {
            let updated = writer::write(
                &nested,
                &[("timezone".into(), Change::Set(Yaml::string(zone)))],
                None,
            )?;
            let mut source = doc.source().to_owned();
            source.replace_range(
                start + header.len() + 1..start + entry.text().len(),
                &updated,
            );
            let mut expected = doc.frontmatter().clone();
            expected.insert("settings", Yaml::Map(settings.clone()));
            let verified = Document::parse(&source, RecordFormat::YamlDocument);
            if verified.problem().is_none() && *verified.frontmatter() == expected {
                return Ok(source);
            }
        }
    }
    writer::write(
        doc,
        &[("settings".into(), Change::Set(Yaml::Map(settings)))],
        None,
    )
}

/// Keep the runtime's default resource paths in folders that previously had
/// no config. The caller only supplies a zone checked against the pinned tzdb.
pub(super) fn config_for_existing_folder(timezone: Option<&str>) -> String {
    let mut config = String::from("spec_version: \"0.3.0\"\n");
    if let Some(zone) = timezone {
        config.push_str(&format!("settings:\n  timezone: \"{zone}\"\n"));
    }
    config
}

pub(super) async fn read_collection_config(
    rt: &Arc<crate::runtime::Runtime>,
) -> Result<Option<(String, Hash)>, ControlError> {
    let params = Cbor::Map(vec![(Cbor::Uint(0), Cbor::Text(CONFIG_PATH.into()))]);
    match host_call(rt, "get_resource", params).await {
        Ok(Cbor::Map(fields)) => {
            let field = |id| {
                fields
                    .iter()
                    .find_map(|(k, v)| (*k == Cbor::Uint(id)).then_some(v))
            };
            if let (Some(Cbor::Text(source)), Some(revision)) = (field(4), field(1))
                && let Ok(revision) = Hash::from_cbor(revision)
            {
                return Ok(Some((source.clone(), revision)));
            }
            Err(ControlError::internal(
                "the replica's config does not decode",
            ))
        }
        Err(error) if error.code == "not_found" => Ok(None),
        Err(error) => Err(error),
        _ => Err(ControlError::internal(
            "the replica's config does not decode",
        )),
    }
}

pub(super) async fn put_collection_config(
    rt: &Arc<crate::runtime::Runtime>,
    doc: String,
    base_revision: Option<Hash>,
) -> Result<(), ControlError> {
    let submit = SubmitParams {
        ops: vec![Op::ResourcePut(ResourcePut {
            path: CONFIG_PATH.into(),
            doc: Text::Inline(doc),
            base_revision,
            must_not_exist: base_revision.is_none().then_some(true),
        })],
        mutation_id: None,
        conflict_mode: Some(mdbn_wire::intent::ConflictMode::Reject),
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: Some(WaitFor::Confirmed),
        validation: None,
    };
    let result = host_call(rt, "submit", submit.to_cbor()).await?;
    let receipts: Vec<Receipt> = Wire::from_cbor(&result)
        .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
    match receipts.as_slice() {
        [receipt]
            if receipt.state == ReceiptState::Confirmed
                && receipt.status == Some(mdbn_wire::entry::Status::Applied)
                && receipt.published != Some(mdbn_wire::client::PublishState::NotPublished) =>
        {
            Ok(())
        }
        _ => Err(receipts
            .first()
            .and_then(|r| r.problem.clone())
            .map(problem_error)
            .unwrap_or_else(|| {
                ControlError::unavailable(
                    "config_write_unconfirmed",
                    "The collection has not confirmed the config update.",
                )
            })),
    }
}
