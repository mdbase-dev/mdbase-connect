use super::*;

pub(super) fn add_reviewable_setup_adoptions(
    setup: &mut mdbase::v03::CollectionSetup,
    result: &mdbase::v03::OperationResult,
) -> bool {
    let adoptions = mdbase_connect_protocol::reviewable_type_pack_adoptions(&result.result);
    let mut changed = false;
    for (pack_id, resources) in adoptions {
        let Some(pack) = setup
            .provisions
            .type_packs
            .iter_mut()
            .find(|pack| pack.provision.manifest["id"].as_str() == Some(pack_id.as_str()))
        else {
            continue;
        };
        for (target, current_digest) in resources {
            changed |= pack
                .options
                .adopt_resources
                .insert(target, current_digest.clone())
                .as_deref()
                != Some(current_digest.as_str());
        }
    }
    changed
}

pub(super) fn type_pack_setup_error(result: &mdbase::v03::OperationResult) -> ConnectError {
    let message = result
        .diagnostics
        .first()
        .map(|diagnostic| diagnostic.message.clone())
        .or_else(|| {
            result.result["resources"]
                .as_array()
                .and_then(|resources| {
                    resources
                        .iter()
                        .find(|resource| resource["action"] == "conflict")
                })
                .and_then(|resource| resource["reason"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Contract setup was rejected.".to_string());
    let mut diagnostics = result
        .diagnostics
        .iter()
        .filter_map(|diagnostic| serde_json::to_value(diagnostic).ok())
        .collect::<Vec<_>>();
    if diagnostics.is_empty() {
        diagnostics.push(json!({
            "code": "collection_setup_conflict",
            "severity": "error",
            "message": message,
        }));
    }
    ConnectError::ApplicationSetupRejected {
        message,
        diagnostics,
    }
}

pub(super) fn required_setup_string(result: &Value, key: &str) -> Result<String, ConnectError> {
    result[key].as_str().map(str::to_string).ok_or_else(|| {
        ConnectError::InvalidInput(format!("Collection setup assessment returned no {key}."))
    })
}
