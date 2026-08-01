use super::*;
use unicode_normalization::UnicodeNormalization;

const RESERVED_DIRECTORIES: &[&str] = &[
    ".mdbase",
    ".git",
    "node_modules",
    "_contracts",
    "_schemas",
    "_types",
    "_views",
];

pub(super) fn validate_hosted_file_path(path: &str) -> ApiResult<()> {
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains('\\')
        || path.chars().any(|character| character.is_control())
    {
        return Err(invalid_file_path());
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| {
        component.is_empty()
            || matches!(*component, "." | "..")
            || component.starts_with('.')
            || component.ends_with([' ', '.'])
            || component.contains(['<', '>', ':', '"', '|', '?', '*'])
            || windows_reserved_name(component)
            || RESERVED_DIRECTORIES
                .iter()
                .any(|reserved| component.eq_ignore_ascii_case(reserved))
    }) {
        return Err(invalid_file_path());
    }
    if path
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("md"))
    {
        return Err(ApiError::bad_request(
            "markdown_is_not_a_file_attachment",
            "Markdown documents use record operations, not collection file operations.",
        ));
    }
    Ok(())
}

pub(super) fn portable_file_path_key(path: &str) -> String {
    path.nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .nfc()
        .collect()
}

pub(super) fn file_path_in_folder(path: &str, folder: &str) -> bool {
    path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn windows_reserved_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or_default();
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

fn invalid_file_path() -> ApiError {
    ApiError::bad_request(
        "invalid_file_path",
        "File paths must be portable, visible, collection-relative paths.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_file_paths_are_visible_portable_and_non_markdown() {
        for valid in ["photo.png", "Project assets/diagram.svg", "notes.txt"] {
            validate_hosted_file_path(valid).unwrap();
        }
        for invalid in [
            "",
            "/absolute.png",
            "folder/",
            "a//b",
            "../escape",
            ".hidden/file",
            "Folder/.hidden",
            "node_modules/file.bin",
            "_types/icon.bin",
            "CON.txt",
            "bad?.png",
            "note.md",
            "NOTE.MD",
        ] {
            assert!(validate_hosted_file_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn path_keys_match_case_and_unicode_portability_aliases() {
        assert_eq!(
            portable_file_path_key("Assets/CAFÉ.png"),
            portable_file_path_key("assets/cafe\u{301}.PNG")
        );
        assert!(file_path_in_folder("Assets/icons/add.svg", "Assets"));
        assert!(!file_path_in_folder("Assets-old/icon.svg", "Assets"));
    }
}
