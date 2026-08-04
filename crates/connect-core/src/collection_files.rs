use crate::ConnectError;
use chrono::{DateTime, SecondsFormat, Utc};
use mdbase::file_path::FilePathError;
use mdbase::Collection;
use mdbase_connect_protocol::FileMediaClass;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

const RESERVED_DIRECTORIES: &[&str] = &["_contracts", "_schemas", "_types", "_views"];
const DEPENDENCY_DIRECTORIES: &[&str] = &["node_modules"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalFileIdentity {
    pub device: u64,
    pub file: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionFileCandidate {
    pub path: String,
    pub path_key: String,
    pub absolute_path: PathBuf,
    pub size: u64,
    pub modified_at: String,
    pub media_type: Option<String>,
    pub media_class: FileMediaClass,
    pub physical_identity: Option<PhysicalFileIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionFileIssue {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectionFileInventory {
    pub files: Vec<CollectionFileCandidate>,
    pub issues: Vec<CollectionFileIssue>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectionFileInclusion {
    pub images: bool,
    pub audio: bool,
    pub videos: bool,
    pub pdfs: bool,
    pub other: bool,
    pub excluded_folders: BTreeSet<String>,
}

impl CollectionFileInclusion {
    pub fn includes(&self, media_class: FileMediaClass) -> bool {
        match media_class {
            FileMediaClass::Image => self.images,
            FileMediaClass::Audio => self.audio,
            FileMediaClass::Video => self.videos,
            FileMediaClass::Pdf => self.pdfs,
            FileMediaClass::Other => self.other,
        }
    }
}

/// Discover non-Markdown collection files without traversing hard-excluded roots.
///
/// `managed_paths` must come from the mdbase snapshot. This keeps record and
/// structural-resource classification owned by mdbase instead of duplicating
/// it in Connect.
pub fn discover_collection_files(
    collection: &Collection,
    managed_paths: &BTreeSet<String>,
) -> Result<CollectionFileInventory, ConnectError> {
    let root = collection.root().canonicalize()?;
    let mut inventory = CollectionFileInventory::default();
    visit_directory(collection, &root, &root, managed_paths, &mut inventory)?;
    remove_portable_aliases(&mut inventory);
    inventory
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    inventory.issues.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then_with(|| left.code.cmp(right.code))
    });
    Ok(inventory)
}

/// Apply sync inclusion independently from authority inventory and app grants.
pub fn select_collection_files<'a>(
    inventory: &'a CollectionFileInventory,
    inclusion: &CollectionFileInclusion,
) -> Result<Vec<&'a CollectionFileCandidate>, ConnectError> {
    let excluded = validated_excluded_folders(&inclusion.excluded_folders)?;
    Ok(inventory
        .files
        .iter()
        .filter(|file| {
            inclusion.includes(file.media_class) && !excluded_path(&file.path, &excluded)
        })
        .collect())
}

fn visit_directory(
    collection: &Collection,
    root: &Path,
    directory: &Path,
    managed_paths: &BTreeSet<String>,
    inventory: &mut CollectionFileInventory,
) -> Result<(), ConnectError> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let absolute_path = entry.path();
        let relative_path = absolute_path.strip_prefix(root).map_err(|_| {
            ConnectError::CollectionOpen("Collection file escaped its authority root.".to_string())
        })?;
        let Some(relative) = relative_path.to_str().map(path_with_forward_slashes) else {
            inventory.issues.push(CollectionFileIssue {
                path: relative_path.to_string_lossy().to_string(),
                code: "non_unicode_path",
                message: "Collection files must have Unicode paths.".to_string(),
            });
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            inventory.issues.push(CollectionFileIssue {
                path: relative,
                code: "non_unicode_path",
                message: "Collection files must have Unicode names.".to_string(),
            });
            continue;
        };
        let metadata = fs::symlink_metadata(&absolute_path)?;
        if is_link_or_reparse_point(&metadata) {
            inventory.issues.push(CollectionFileIssue {
                path: relative,
                code: "symlink_excluded",
                message: "Symbolic links are never collection files.".to_string(),
            });
            continue;
        }
        if metadata.is_dir() {
            if excluded_directory(&name) || nested_collection(&absolute_path) {
                continue;
            }
            visit_directory(collection, root, &absolute_path, managed_paths, inventory)?;
            continue;
        }
        if !metadata.is_file() {
            inventory.issues.push(CollectionFileIssue {
                path: relative,
                code: "non_regular_file",
                message: "Only regular files can be collection files.".to_string(),
            });
            continue;
        }
        if managed_paths.contains(&relative) {
            continue;
        }
        match collection.validate_file_path(&relative) {
            Ok(path) if path.as_str() == relative => {}
            Ok(_) => {
                inventory.issues.push(CollectionFileIssue {
                    path: relative,
                    code: "unsafe_path",
                    message: "path is not in canonical forward-slash form".to_string(),
                });
                continue;
            }
            Err(FilePathError::InvalidPath(error)) => {
                inventory.issues.push(CollectionFileIssue {
                    path: relative,
                    code: "unsafe_path",
                    message: error.to_string(),
                });
                continue;
            }
            Err(
                FilePathError::HiddenComponent
                | FilePathError::Reserved
                | FilePathError::RecordPath,
            ) => continue,
        }
        let (multiple_hard_links, physical_identity) =
            physical_file_information(&absolute_path, &metadata)?;
        if multiple_hard_links {
            inventory.issues.push(CollectionFileIssue {
                path: relative,
                code: "hard_link_excluded",
                message: "Hard-linked files are excluded because writes could escape the collection boundary."
                    .to_string(),
            });
            continue;
        }
        let (media_class, media_type) = classify_media(&relative);
        let modified_at = metadata
            .modified()
            .map(DateTime::<Utc>::from)
            .map(|value| value.to_rfc3339_opts(SecondsFormat::Nanos, true))
            .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());
        inventory.files.push(CollectionFileCandidate {
            path_key: portable_path_key(&relative),
            path: relative,
            absolute_path,
            size: metadata.len(),
            modified_at,
            media_type,
            media_class,
            physical_identity,
        });
    }
    Ok(())
}

fn validated_excluded_folders(
    folders: &BTreeSet<String>,
) -> Result<BTreeSet<String>, ConnectError> {
    folders
        .iter()
        .map(|folder| {
            let canonical = folder.trim_end_matches('/');
            validate_portable_path(canonical).map_err(|message| {
                ConnectError::Settings(format!("Invalid excluded file folder {folder}: {message}"))
            })?;
            Ok(portable_path_key(canonical))
        })
        .collect()
}

pub(crate) fn excluded_directory(name: &str) -> bool {
    hidden_name(name)
        || RESERVED_DIRECTORIES
            .iter()
            .chain(DEPENDENCY_DIRECTORIES)
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

fn excluded_path(relative: &str, excluded: &BTreeSet<String>) -> bool {
    let key = portable_path_key(relative);
    excluded
        .iter()
        .any(|folder| key == *folder || key.starts_with(&format!("{folder}/")))
}

fn nested_collection(directory: &Path) -> bool {
    fs::symlink_metadata(directory.join("mdbase.yaml")).is_ok_and(|metadata| metadata.is_file())
}

pub(crate) fn hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

pub(crate) fn validate_portable_path(relative: &str) -> Result<(), String> {
    let path = mdbase::api::CollectionPath::new(relative).map_err(|error| error.to_string())?;
    if path.as_str() != relative {
        return Err("path is not in canonical forward-slash form".to_string());
    }
    Ok(())
}

pub(crate) fn portable_path_key(relative: &str) -> String {
    relative
        .nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .nfc()
        .collect()
}

fn remove_portable_aliases(inventory: &mut CollectionFileInventory) {
    let mut paths = BTreeMap::<String, Vec<String>>::new();
    for file in &inventory.files {
        paths
            .entry(file.path_key.clone())
            .or_default()
            .push(file.path.clone());
    }
    let aliases = paths
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .collect::<BTreeMap<_, _>>();
    if aliases.is_empty() {
        return;
    }
    inventory
        .files
        .retain(|file| !aliases.contains_key(&file.path_key));
    for (_, paths) in aliases {
        let joined = paths.join(", ");
        for path in paths {
            inventory.issues.push(CollectionFileIssue {
                path,
                code: "path_alias",
                message: format!(
                    "Collection file paths alias on a supported filesystem: {joined}."
                ),
            });
        }
    }
}

fn path_with_forward_slashes(path: &str) -> String {
    path.replace(std::path::MAIN_SEPARATOR, "/")
}

pub(crate) fn extension(path: &str) -> Option<&str> {
    path.rsplit_once('.').map(|(_, extension)| extension)
}

pub(crate) fn classify_media(path: &str) -> (FileMediaClass, Option<String>) {
    let extension = extension(path).unwrap_or_default().to_ascii_lowercase();
    let (class, media_type) = match extension.as_str() {
        "avif" => (FileMediaClass::Image, "image/avif"),
        "bmp" => (FileMediaClass::Image, "image/bmp"),
        "gif" => (FileMediaClass::Image, "image/gif"),
        "jpeg" | "jpg" => (FileMediaClass::Image, "image/jpeg"),
        "png" => (FileMediaClass::Image, "image/png"),
        "svg" => (FileMediaClass::Image, "image/svg+xml"),
        "webp" => (FileMediaClass::Image, "image/webp"),
        "flac" => (FileMediaClass::Audio, "audio/flac"),
        "m4a" => (FileMediaClass::Audio, "audio/mp4"),
        "mp3" => (FileMediaClass::Audio, "audio/mpeg"),
        "oga" | "ogg" => (FileMediaClass::Audio, "audio/ogg"),
        "opus" => (FileMediaClass::Audio, "audio/opus"),
        "wav" => (FileMediaClass::Audio, "audio/wav"),
        "3gp" => (FileMediaClass::Video, "video/3gpp"),
        "mkv" => (FileMediaClass::Video, "video/x-matroska"),
        "mov" => (FileMediaClass::Video, "video/quicktime"),
        "mp4" => (FileMediaClass::Video, "video/mp4"),
        "webm" => (FileMediaClass::Video, "video/webm"),
        "pdf" => (FileMediaClass::Pdf, "application/pdf"),
        _ => return (FileMediaClass::Other, None),
    };
    (class, Some(media_type.to_string()))
}

#[cfg(windows)]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(unix)]
fn physical_file_information(
    _path: &Path,
    metadata: &fs::Metadata,
) -> Result<(bool, Option<PhysicalFileIdentity>), ConnectError> {
    use std::os::unix::fs::MetadataExt;

    Ok((
        metadata.nlink() > 1,
        Some(PhysicalFileIdentity {
            device: metadata.dev(),
            file: metadata.ino(),
        }),
    ))
}

#[cfg(windows)]
fn physical_file_information(
    path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(bool, Option<PhysicalFileIdentity>), ConnectError> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = fs::File::open(path)?;
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: the handle remains open for this call and Windows initializes
    // the complete BY_HANDLE_FILE_INFORMATION structure on success.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: a successful GetFileInformationByHandle initialized the value.
    let information = unsafe { information.assume_init() };
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok((
        information.nNumberOfLinks > 1,
        Some(PhysicalFileIdentity {
            device: u64::from(information.dwVolumeSerialNumber),
            file: file_index,
        }),
    ))
}

#[cfg(not(any(unix, windows)))]
fn physical_file_information(
    _path: &Path,
    _metadata: &fs::Metadata,
) -> Result<(bool, Option<PhysicalFileIdentity>), ConnectError> {
    Ok((false, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_os = "macos"))]
    use std::io::Write;
    use tempfile::tempdir;

    fn all_files() -> CollectionFileInclusion {
        CollectionFileInclusion {
            images: true,
            audio: true,
            videos: true,
            pdfs: true,
            other: true,
            excluded_folders: BTreeSet::new(),
        }
    }

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, relative.as_bytes()).unwrap();
    }

    fn inventory(root: &Path, managed_paths: &BTreeSet<String>) -> CollectionFileInventory {
        inventory_with_config(root, "spec_version: 0.3.0\n", managed_paths)
    }

    fn inventory_with_config(
        root: &Path,
        config: &str,
        managed_paths: &BTreeSet<String>,
    ) -> CollectionFileInventory {
        fs::write(root.join("mdbase.yaml"), config).unwrap();
        let collection = Collection::open(root).unwrap();
        discover_collection_files(&collection, managed_paths).unwrap()
    }

    #[test]
    fn inventory_classifies_files_without_an_attachment_root() {
        let root = tempdir().unwrap();
        write(root.path(), "mdbase.yaml");
        write(root.path(), "Journal/photo.PNG");
        write(root.path(), "Audio/interview.mp3");
        write(root.path(), "exports/demo.webm");
        write(root.path(), "papers/design.pdf");
        write(root.path(), "data/archive.zip");
        let inventory = inventory(root.path(), &BTreeSet::new());
        let classified = inventory
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.media_class))
            .collect::<Vec<_>>();
        assert_eq!(
            classified,
            vec![
                ("Audio/interview.mp3", FileMediaClass::Audio),
                ("Journal/photo.PNG", FileMediaClass::Image),
                ("data/archive.zip", FileMediaClass::Other),
                ("exports/demo.webm", FileMediaClass::Video),
                ("papers/design.pdf", FileMediaClass::Pdf),
            ]
        );
        assert!(inventory.issues.is_empty());
    }

    #[test]
    fn hard_exclusions_win_before_media_configuration() {
        let root = tempdir().unwrap();
        for path in [
            ".obsidian/plugins/plugin.js",
            ".hidden.png",
            "visible/.cache/image.png",
            "_types/example.json",
            "_contracts/example.json",
            "_schemas/example.json",
            "_views/example.json",
            "node_modules/package/image.png",
            "notes/record.md",
            "mdbase.yaml",
        ] {
            write(root.path(), path);
        }
        write(root.path(), "nested/mdbase.yaml");
        write(root.path(), "nested/asset.png");
        let inventory = inventory(root.path(), &BTreeSet::new());
        assert!(inventory.files.is_empty());
        assert!(inventory.issues.is_empty());
    }

    #[test]
    fn mdbase_managed_paths_and_user_exclusions_are_not_rediscovered() {
        let root = tempdir().unwrap();
        write(root.path(), "records/generated.bin");
        write(root.path(), "private/secret.png");
        write(root.path(), "public/ok.png");
        let mut managed = BTreeSet::new();
        managed.insert("records/generated.bin".to_string());
        let policy = all_files();
        let inventory = inventory_with_config(
            root.path(),
            "spec_version: 0.3.0\nsettings:\n  exclude: [private/**]\n",
            &managed,
        );
        assert_eq!(inventory.files.len(), 1);
        let selected = select_collection_files(&inventory, &policy).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].path, "public/ok.png");
    }

    #[test]
    fn media_toggles_are_independent_from_namespace_safety() {
        let root = tempdir().unwrap();
        write(root.path(), "image.png");
        write(root.path(), "document.pdf");
        write(root.path(), "archive.zip");
        let policy = CollectionFileInclusion {
            images: true,
            ..CollectionFileInclusion::default()
        };
        let inventory = inventory(root.path(), &BTreeSet::new());
        let selected = select_collection_files(&inventory, &policy).unwrap();
        assert_eq!(
            selected
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["image.png"]
        );
    }

    #[test]
    fn portable_aliases_are_reported_and_both_files_are_excluded() {
        let root = tempdir().unwrap();
        write(root.path(), "Notes/Example.png");
        write(root.path(), "notes/example.png");
        if fs::read_dir(root.path()).unwrap().count() < 2 {
            // A case-insensitive filesystem cannot represent both portable
            // spellings at once, so there is no pair for the scanner to reject.
            return;
        }
        let inventory = inventory(root.path(), &BTreeSet::new());
        assert!(inventory.files.is_empty());
        assert_eq!(inventory.issues.len(), 2);
        assert!(inventory
            .issues
            .iter()
            .all(|issue| issue.code == "path_alias"));
    }

    #[test]
    fn unicode_equivalent_paths_alias_and_invalid_exclusions_fail_closed() {
        let root = tempdir().unwrap();
        write(root.path(), "Café/photo.png");
        write(root.path(), "Café/photo.png");
        let distinct_spellings = fs::read_dir(root.path()).unwrap().count() == 2;
        let inventory = inventory(root.path(), &BTreeSet::new());
        if distinct_spellings {
            assert!(inventory.files.is_empty());
            assert_eq!(inventory.issues.len(), 2);
            assert!(inventory
                .issues
                .iter()
                .all(|issue| issue.code == "path_alias"));
        } else {
            // Normalizing filesystems such as the default macOS APFS cannot
            // represent the two spellings as distinct directory entries.
            assert_eq!(inventory.files.len(), 1);
            assert!(inventory.issues.is_empty());
        }

        let mut policy = all_files();
        policy.excluded_folders.insert("../outside".to_string());
        let error = select_collection_files(&inventory, &policy).unwrap_err();
        assert_eq!(error.code(), "invalid_config");
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_hard_links_and_non_unicode_names_are_never_files() {
        #[cfg(not(target_os = "macos"))]
        use std::os::unix::ffi::OsStringExt;
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        write(root.path(), "outside.png");
        symlink(
            root.path().join("outside.png"),
            root.path().join("link.png"),
        )
        .unwrap();
        fs::hard_link(
            root.path().join("outside.png"),
            root.path().join("hard.png"),
        )
        .unwrap();
        #[cfg(not(target_os = "macos"))]
        {
            let invalid =
                std::ffi::OsString::from_vec(vec![b'i', b'n', 0xff, b'.', b'p', b'n', b'g']);
            let mut file = fs::File::create(root.path().join(invalid)).unwrap();
            file.write_all(b"invalid").unwrap();
        }

        let inventory = inventory(root.path(), &BTreeSet::new());
        assert!(inventory.files.is_empty());
        let codes = inventory
            .issues
            .iter()
            .map(|issue| issue.code)
            .collect::<BTreeSet<_>>();
        let mut expected = BTreeSet::from(["hard_link_excluded", "symlink_excluded"]);
        #[cfg(not(target_os = "macos"))]
        expected.insert("non_unicode_path");
        assert_eq!(codes, expected);
    }

    #[cfg(unix)]
    #[test]
    fn platform_unsafe_names_are_reported() {
        let root = tempdir().unwrap();
        write(root.path(), "safe.png");
        write(root.path(), "unsafe:name.png");
        write(root.path(), "CON.png");
        let inventory = inventory(root.path(), &BTreeSet::new());
        assert_eq!(inventory.files.len(), 1);
        assert_eq!(inventory.files[0].path, "safe.png");
        assert_eq!(
            inventory
                .issues
                .iter()
                .map(|issue| issue.code)
                .collect::<Vec<_>>(),
            vec!["unsafe_path", "unsafe_path"]
        );
    }
}
