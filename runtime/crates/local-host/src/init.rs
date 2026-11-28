//! Initial config shared by the native library and mdbase CLI and daemon.

use std::io::{self, Write};
use std::path::Path;

use mdbn_core::cel::time::tzdb::NamedZone;

use crate::{CONFIG_FILE, SystemZones};

fn collection_config(name: Option<&str>, timezone: Option<&str>) -> io::Result<String> {
    let detected;
    let zone = match timezone {
        Some(zone)
            if mdbn_core::types::is_plausible_iana_zone(zone) && NamedZone::get(zone).is_ok() =>
        {
            Some(zone)
        }
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Expected an IANA time zone",
            ));
        }
        None => {
            detected = SystemZones::detected_machine_zone();
            detected.as_deref()
        }
    };
    let mut config = String::from("spec_version: \"0.3.0\"\n");
    if let Some(name) = name {
        config.push_str(&format!(
            "name: {}\n",
            serde_json::to_string(name).expect("a string serializes")
        ));
    }
    config.push_str(
        "settings:\n  types_folder: _mdbase/types\n  contracts_folder: _mdbase/contracts\n",
    );
    if let Some(zone) = zone {
        config.push_str(&format!("  timezone: \"{zone}\"\n"));
    }
    Ok(config)
}

/// Materialize the config and metadata guide if the config does not exist.
pub fn init_collection_config(
    root: &Path,
    name: Option<&str>,
    timezone: Option<&str>,
) -> io::Result<()> {
    std::fs::create_dir_all(root)?;
    let path = root.join(CONFIG_FILE);
    if path.try_exists()? {
        return Ok(());
    }
    let config = collection_config(name, timezone)?;
    if !create(&path, config.as_bytes())? {
        return Ok(());
    }
    std::fs::create_dir_all(root.join("_mdbase"))?;
    create(
        &root.join("_mdbase/README.md"),
        include_bytes!("../../../../templates/mdbase/README.md"),
    )?;
    Ok(())
}

fn create(path: &Path, bytes: &[u8]) -> io::Result<bool> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(bytes)?;
            Ok(true)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error),
    }
}
