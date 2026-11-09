//! Folder inspection: emptiness, canonical paths and classifying a folder's existing collection config.

use super::*;

/// Empty for a join: nothing but hidden entries (`.obsidian`, `.git`, ...). Those
/// are never collection content, so the log's files cannot land on them, and
/// they are left as they are. The replica's private directory (`.mdbase`, any
/// casing) is not ignored: another collection's state may be in it.
pub(super) fn folder_is_empty(root: &std::path::Path) -> Result<bool, ControlError> {
    let private = mdbn_platform_native::OpenOptions::default().private_dir;
    for entry in std::fs::read_dir(root).map_err(|e| ControlError::internal(e.to_string()))? {
        let name = entry
            .map_err(|e| ControlError::internal(e.to_string()))?
            .file_name();
        let name = name.to_string_lossy();
        if !name.starts_with('.') || name.to_lowercase().starts_with(&private.to_lowercase()) {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn local_bootstrap_folder_is_empty(
    root: &std::path::Path,
) -> Result<bool, ControlError> {
    mdbn_local_host::host_lock::inspect_descriptor_directory(|| {
        let private = mdbn_platform_native::OpenOptions::default().private_dir;
        let mut stack = Vec::new();
        for entry in std::fs::read_dir(root).map_err(|e| ControlError::internal(e.to_string()))? {
            let entry = entry.map_err(|e| ControlError::internal(e.to_string()))?;
            if entry.file_name() != std::ffi::OsStr::new(&private)
                || !entry
                    .file_type()
                    .map_err(|e| ControlError::internal(e.to_string()))?
                    .is_dir()
            {
                return Ok(false);
            }
            stack.push((entry.path(), 0));
        }
        let mut count = 0;
        while let Some((dir, depth)) = stack.pop() {
            count += 1;
            if count > 64 || depth > 8 {
                return Ok(false);
            }
            for entry in
                std::fs::read_dir(dir).map_err(|e| ControlError::internal(e.to_string()))?
            {
                let entry = entry.map_err(|e| ControlError::internal(e.to_string()))?;
                // `DirEntry::file_type` does not follow symlinks.
                let kind = entry
                    .file_type()
                    .map_err(|e| ControlError::internal(e.to_string()))?;
                if depth == 0 && kind.is_file() && is_host_lock_file(&entry.file_name()) {
                    continue;
                }
                if !kind.is_dir() || stack.len() >= 64 {
                    return Ok(false);
                }
                stack.push((entry.path(), depth + 1));
            }
        }
        Ok(true)
    })
    .map_err(|_| ControlError::internal("host descriptor I/O unavailable"))?
}

/// The folder host lock's files in the private dir (mdbn-local-host): the lock
/// itself and its diagnostic descriptor. Every native host creates them on open.
fn is_host_lock_file(name: &std::ffi::OsStr) -> bool {
    use mdbn_local_host::host_lock::{DESCRIPTOR_NAME, LOCK_NAME};
    name == std::ffi::OsStr::new(LOCK_NAME) || name == std::ffi::OsStr::new(DESCRIPTOR_NAME)
}

pub(super) fn canonical_dir(p: &std::path::Path) -> Result<std::path::PathBuf, ControlError> {
    let c = std::fs::canonicalize(p).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ControlError::not_found(format!("{} does not exist", p.display()))
        } else {
            ControlError::invalid("unreadable_path", format!("{}: {e}", p.display()))
        }
    })?;
    if !c.is_dir() {
        return Err(ControlError::invalid(
            "not_a_directory",
            format!("{} is not a folder", p.display()),
        ));
    }
    Ok(strip_verbatim(c))
}

/// `\\?\C:\x` → `C:\x` (Windows `canonicalize` returns verbatim paths).
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => std::path::PathBuf::from(rest),
        _ => p,
    }
}

/// The top-level `mdbase.yaml` key under which today's connector keeps a folder's
/// collection identity (`x-mdbase-connect.collection_id`).
pub(super) const LEGACY_IDENTITY_KEY: &str = "x-mdbase-connect";

/// Who manages a folder, from its role marker and `mdbase.yaml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderClaim {
    /// Nobody: adopt it.
    Free,
    /// Claimed by this daemon (v2 marker naming a store ID it issued in
    /// `store-ids.json`, the takeover's `Daemon::store_id`).
    Ours {
        /// Collection ID (kept from Connect).
        collection: String,
        /// This daemon's store ID for it.
        replica_id: String,
    },
    /// Today's connector (a v1 marker, or a Connect identity in `mdbase.yaml` for a
    /// folder the old connector state on this device lists): the takeover runs first.
    Connect(&'static str),
    /// A Connect identity in `mdbase.yaml` for a folder no old connector state on
    /// this device lists (a copied folder, one removed before the migration, or a
    /// device without the old connector). The takeover never reaches it, so it is
    /// adopted only once the user confirms removing that key.
    OrphanedIdentity,
}

/// Classify a folder against the old connector state in `old_state` (if any). A
/// v2 claim by another runtime or device, or an invalid marker, is refused (fail
/// closed).
pub fn classify_folder(
    root: &std::path::Path,
    profile: &Profile,
    old_state: Option<&std::path::Path>,
) -> Result<FolderClaim, ControlError> {
    use mdbn_legacy::marker::{self, Marker};
    let m = marker::read(root)
        .map_err(|e| ControlError::invalid("unreadable_marker", e.to_string()))?;
    match m {
        Marker::Claimed {
            collection,
            replica_id,
        } => {
            let ids = crate::registry::StoreIds::load(&profile.store_ids_file())
                .map_err(|e| ControlError::internal(e.to_string()))?;
            if ids.get(&collection) == Some(replica_id.as_str()) {
                Ok(FolderClaim::Ours {
                    collection,
                    replica_id,
                })
            } else {
                Err(ControlError::new(
                    "conflict",
                    "claimed_by_other_replica",
                    "this folder is claimed by mdbase on another device or profile",
                ))
            }
        }
        Marker::Mirror { .. } => Ok(FolderClaim::Connect("hosted mirror marker")),
        Marker::Invalid(why) => Err(ControlError::invalid(
            "invalid_marker",
            format!("the folder's .mdbase/connect-role.json is invalid ({why})"),
        )),
        Marker::Absent => {
            let identity = read_config(root)?
                .is_some_and(|(_, config)| config.contains_key(LEGACY_IDENTITY_KEY));
            if !identity {
                Ok(FolderClaim::Free)
            } else if crate::takeover::old_state_lists(old_state, root)
                .map_err(|e| ControlError::unavailable("legacy_state_unreadable", e))?
            {
                Ok(FolderClaim::Connect("collection identity in mdbase.yaml"))
            } else {
                Ok(FolderClaim::OrphanedIdentity)
            }
        }
    }
}

/// A folder's `mdbase.yaml` text and top-level mapping (`None`: no file). An empty
/// or non-mapping document has no keys.
fn read_config(
    root: &std::path::Path,
) -> Result<Option<(String, mdbn_core::value::Map)>, ControlError> {
    let text = match std::fs::read_to_string(root.join("mdbase.yaml")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(ControlError::invalid(
                "unreadable_config",
                format!("mdbase.yaml: {e}"),
            ));
        }
    };
    let config = config_map(&text).map_err(|e| {
        ControlError::invalid(
            "invalid_config",
            format!("mdbase.yaml is not valid YAML: {e}"),
        )
    })?;
    Ok(Some((text, config)))
}

fn config_map(text: &str) -> Result<mdbn_core::value::Map, mdbn_core::yaml::YamlError> {
    Ok(match mdbn_core::yaml::parse_value(text)? {
        Some(mdbn_core::value::Value::Map(m)) => m,
        _ => mdbn_core::value::Map::new(),
    })
}

/// `text` without its top-level [`LEGACY_IDENTITY_KEY`] entry, every other byte
/// kept. `None` unless removing the entry's lines yields exactly the same mapping
/// minus that key.
pub(super) fn without_legacy_identity(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let opens_entry = |line: &str| {
        let key = [
            LEGACY_IDENTITY_KEY.to_owned(),
            format!("\"{LEGACY_IDENTITY_KEY}\""),
            format!("'{LEGACY_IDENTITY_KEY}'"),
        ];
        key.iter().any(|k| {
            line.strip_prefix(k.as_str())
                .and_then(|r| r.trim_start_matches([' ', '\t']).strip_prefix(':'))
                .is_some_and(|r| r.is_empty() || r.starts_with([' ', '\t', '\r', '\n']))
        })
    };
    let start = lines.iter().position(|l| opens_entry(l))?;
    // The entry runs to the next line at column 0; blank lines before that stay.
    let mut end = start + 1;
    while end < lines.len() && (lines[end].trim().is_empty() || lines[end].starts_with([' ', '\t']))
    {
        end += 1;
    }
    while end > start + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    let out: String = lines[..start]
        .iter()
        .chain(&lines[end..])
        .copied()
        .collect();
    let mut expected = config_map(text).ok()?;
    expected.remove(LEGACY_IDENTITY_KEY)?;
    (config_map(&out).ok()? == expected).then_some(out)
}

/// Remove the orphaned Connect identity from `root`'s `mdbase.yaml`, as the user
/// confirmed in `collection.add`.
pub(super) fn remove_legacy_identity(root: &std::path::Path) -> Result<(), ControlError> {
    let path = root.join("mdbase.yaml");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| ControlError::invalid("unreadable_config", format!("mdbase.yaml: {e}")))?;
    let out = without_legacy_identity(&text).ok_or_else(|| {
        ControlError::invalid(
            "legacy_identity_not_removable",
            format!(
                "the `{LEGACY_IDENTITY_KEY}` entry in mdbase.yaml cannot be removed \
                 automatically; delete that key by hand, then add the folder again"
            ),
        )
    })?;
    // The user's file keeps its permissions (`write_atomic` creates it private).
    let permissions = std::fs::metadata(&path).map(|m| m.permissions());
    permissions
        .and_then(|p| {
            fsutil::write_atomic(&path, out.as_bytes())?;
            std::fs::set_permissions(&path, p)
        })
        .map_err(|e| ControlError::internal(format!("mdbase.yaml: {e}")))
}
