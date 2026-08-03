use super::*;
pub(super) fn render_connect_profile(
    report: &mdbase_connect_core::profiling::ProfileReport,
    output: Option<&Path>,
    output_json: bool,
) -> Result<(), CliError> {
    let serialized = serde_json::to_string_pretty(report)
        .map_err(|error| CliError::internal(error.to_string()))?;
    if let Some(output) = output {
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| CliError::internal(error.to_string()))?;
        }
        std::fs::write(output, format!("{serialized}\n"))
            .map_err(|error| CliError::internal(error.to_string()))?;
    }
    if output_json {
        println!("{serialized}");
    } else {
        println!("Connect profile (read-only)");
        println!(
            "{:<26} {:>6} {:>11} {:>11} {:>11}",
            "operation", "runs", "mean", "p95", "max"
        );
        for operation in &report.operations {
            println!(
                "{:<26} {:>6} {:>8.2} ms {:>8.2} ms {:>8.2} ms",
                operation.name,
                operation.iterations,
                operation.mean_ms,
                operation.p95_ms,
                operation.max_ms,
            );
        }
    }
    Ok(())
}

pub(super) fn render_data_result(
    value: &Value,
    pretty: bool,
    diagnostic: bool,
) -> Result<(), CliError> {
    let pretty = pretty || std::io::stdout().is_terminal();
    let rendered = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
    .map_err(|error| CliError::internal(error.to_string()))?;
    if diagnostic {
        eprintln!("{rendered}");
    } else {
        println!("{rendered}");
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]

pub(super) enum OutputKind {
    Status,
    Daemon,
    Doctor,
    Collections,
    Collection,
    Access,
    Activity,
    Account,
    Mirrors,
    Mirror,
    Generic,
}

pub(super) fn print_result(json: bool, kind: OutputKind, value: &Value) -> Result<(), CliError> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(value)
                .map_err(|error| CliError::internal(error.to_string()))?
        );
        return Ok(());
    }
    println!("{}", render_human(kind, value));
    Ok(())
}

pub(super) fn render_human(kind: OutputKind, value: &Value) -> String {
    match kind {
        OutputKind::Status => {
            let state = value["state"]
                .as_str()
                .unwrap_or("unknown")
                .replace('_', " ");
            let collections = value["registered_collections"].as_u64().unwrap_or(0);
            let paused = value["paused"].as_bool().unwrap_or(false);
            format!(
                "{}\nCollections: {}\nAccess: {}",
                sentence_case(&state),
                collections,
                if paused { "paused" } else { "available" }
            )
        }
        OutputKind::Daemon => {
            if value["running"] == Value::Bool(true) {
                "Daemon is running.".to_string()
            } else if value["installed"] == Value::Bool(true) {
                "Daemon is installed but not running.".to_string()
            } else if value["installed"] == Value::Bool(false) {
                "Daemon is not installed.".to_string()
            } else if value["shown"] == Value::Bool(true) {
                String::new()
            } else {
                value
                    .as_object()
                    .and_then(|object| object.keys().next())
                    .map(|key| format!("Daemon {}.", key.replace('_', " ")))
                    .unwrap_or_else(|| "Done.".to_string())
            }
        }
        OutputKind::Doctor => {
            let healthy = value["healthy"].as_bool().unwrap_or(false);
            let state = value["state_directory"]["state"]
                .as_str()
                .unwrap_or("unknown");
            let daemon = value["daemon"]["state"].as_str().unwrap_or("unknown");
            format!(
                "{}\nState directory: {}\nDaemon: {}",
                if healthy {
                    "Connect is healthy."
                } else {
                    "Connect needs attention."
                },
                state,
                daemon
            )
        }
        OutputKind::Collections => render_rows(
            value.as_array().map(Vec::as_slice).unwrap_or(&[]),
            &["NAME", "STATE", "ID", "PATH"],
            |item| {
                vec![
                    text(item, "display_name"),
                    if item["enabled"].as_bool().unwrap_or(false) {
                        "available".to_string()
                    } else {
                        "paused".to_string()
                    },
                    text(item, "id"),
                    text(item, "path"),
                ]
            },
            "No computer-owned collections.",
        ),
        OutputKind::Collection => {
            format!(
                "{}\n{}\n{}",
                text(value, "display_name"),
                text(value, "id"),
                text(value, "path")
            )
        }
        OutputKind::Access => {
            let requests = value["pending_authorizations"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let grants = value["grants"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            format!(
                "Pending requests: {}\nActive grants: {}",
                requests.len(),
                grants.len()
            )
        }
        OutputKind::Activity => render_rows(
            value.as_array().map(Vec::as_slice).unwrap_or(&[]),
            &["TIME", "ACTION", "OUTCOME"],
            |item| {
                vec![
                    text(item, "occurred_at"),
                    text(item, "action"),
                    text(item, "outcome"),
                ]
            },
            "No recent activity.",
        ),
        OutputKind::Account => {
            if value["configured"] == Value::Bool(false) {
                return "This computer is not connected to an account.".to_string();
            }
            let account = value.get("account").unwrap_or(value);
            let user = account["user_name"].as_str().unwrap_or("Connected");
            let email = account["user_email"].as_str().unwrap_or("");
            let computer = account["connector_name"].as_str().unwrap_or("");
            [user, email, computer]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
        OutputKind::Mirrors => render_rows(
            value.as_array().map(Vec::as_slice).unwrap_or(&[]),
            &["NAME", "STATE", "MODE", "SELECTIVE SYNC", "ID", "PATH"],
            |item| {
                vec![
                    text(item, "name"),
                    text(item, "state").replace('_', " "),
                    text(item, "mode").replace('_', " "),
                    mirror_selective_sync(item),
                    text(item, "replica_id"),
                    text(item, "path"),
                ]
            },
            "No hosted collection mirrors.",
        ),
        OutputKind::Mirror => {
            let error = value["error"].as_str();
            format!(
                "{}\n{}\n{}\nSelective sync: {}\n{}{}",
                text(value, "name"),
                text(value, "state").replace('_', " "),
                text(value, "path"),
                mirror_selective_sync(value),
                text(value, "replica_id"),
                error.map(|error| format!("\n{error}")).unwrap_or_default()
            )
        }
        OutputKind::Generic => {
            if value.is_null() || value == &serde_json::json!({}) {
                "Done.".to_string()
            } else {
                serde_json::to_string_pretty(value).unwrap_or_else(|_| "Done.".to_string())
            }
        }
    }
}

fn mirror_selective_sync(value: &Value) -> String {
    let classes = value
        .pointer("/selective_sync/file_classes")
        .and_then(Value::as_array)
        .map(|classes| classes.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let files = if classes.is_empty() {
        "Markdown only".to_string()
    } else {
        classes.join(", ")
    };
    let excluded = value
        .pointer("/selective_sync/excluded_folders")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if excluded == 0 {
        files
    } else {
        format!("{files}; {excluded} folder(s) excluded")
    }
}

pub(super) fn text(value: &Value, field: &str) -> String {
    value[field]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value[field].to_string().trim_matches('"').to_string())
}

pub(super) fn sentence_case(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}

pub(super) fn render_rows(
    values: &[Value],
    headings: &[&str],
    row: impl Fn(&Value) -> Vec<String>,
    empty: &str,
) -> String {
    if values.is_empty() {
        return empty.to_string();
    }
    let rows = values.iter().map(row).collect::<Vec<_>>();
    let mut widths = headings
        .iter()
        .map(|heading| heading.len())
        .collect::<Vec<_>>();
    for values in &rows {
        for (index, value) in values.iter().enumerate() {
            widths[index] = widths[index].max(value.chars().count());
        }
    }
    let format_row = |values: &[String]| {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| format!("{value:<width$}", width = widths[index]))
            .collect::<Vec<_>>()
            .join("  ")
            .trim_end()
            .to_string()
    };
    let heading_values = headings
        .iter()
        .map(|heading| heading.to_string())
        .collect::<Vec<_>>();
    std::iter::once(format_row(&heading_values))
        .chain(rows.iter().map(|values| format_row(values)))
        .collect::<Vec<_>>()
        .join("\n")
}
