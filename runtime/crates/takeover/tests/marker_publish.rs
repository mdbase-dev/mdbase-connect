//! The temporary native marker writer is exclusive and never replaces evidence.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, missing_docs)]
use mdbn_takeover::takeover::write_v2_marker;
use std::fs;
use std::path::{Path, PathBuf};

const CID: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
const REP: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";
fn root(name: &str) -> PathBuf {
    let root = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join("marker-publish")
        .join(name);
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join(".mdbase")).unwrap();
    root
}
fn write(root: &Path) -> mdbn_takeover::Result<()> {
    write_v2_marker(root, CID, REP, "t", "n")
}
#[test]
fn existing_marker_and_fixed_temp_are_never_truncated() {
    let root = root("existing");
    let marker = root.join(".mdbase/connect-role.json");
    let old_temp = root.join(".mdbase/.connect-role.json.tmp");
    fs::write(&marker, b"another runtime claim").unwrap();
    fs::write(&old_temp, b"pre-existing evidence").unwrap();
    assert!(write(&root).is_err());
    assert_eq!(fs::read(marker).unwrap(), b"another runtime claim");
    assert_eq!(fs::read(old_temp).unwrap(), b"pre-existing evidence");
    assert_eq!(fs::read_dir(root.join(".mdbase")).unwrap().count(), 2);
}
#[test]
fn concurrent_claimants_cannot_overwrite_one_another() {
    let root = root("race");
    let a = root.clone();
    let b = root.clone();
    let one = std::thread::spawn(move || write(&a));
    let two = std::thread::spawn(move || {
        write_v2_marker(&b, CID, "11111111-2222-4333-8444-555555555555", "t", "n")
    });
    assert_ne!(one.join().unwrap().is_ok(), two.join().unwrap().is_ok());
    assert_eq!(fs::read_dir(root.join(".mdbase")).unwrap().count(), 1);
    let bytes = fs::read(root.join(".mdbase/connect-role.json")).unwrap();
    assert!(matches!(
        mdbn_legacy::marker::parse(&bytes),
        mdbn_legacy::marker::Marker::Claimed { .. }
    ));
}
#[cfg(unix)]
#[test]
fn symlinks_are_not_followed_and_published_marker_is_owner_only() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = root("symlinks");
    let victim = root.join("user.md");
    fs::write(&victim, b"never truncate me").unwrap();
    let old_temp = root.join(".mdbase/.connect-role.json.tmp");
    symlink(&victim, &old_temp).unwrap();
    let marker = root.join(".mdbase/connect-role.json");
    symlink(&victim, &marker).unwrap();
    assert!(write(&root).is_err());
    assert_eq!(fs::read(&victim).unwrap(), b"never truncate me");
    assert!(
        fs::symlink_metadata(&marker)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_file(&marker).unwrap();
    write(&root).unwrap();
    assert_eq!(fs::read(&victim).unwrap(), b"never truncate me");
    assert_eq!(
        fs::metadata(marker).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        fs::symlink_metadata(old_temp)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
#[cfg(unix)]
#[test]
fn symlink_metadata_directory_is_refused() {
    use std::os::unix::fs::symlink;
    let root = root("directory-symlink");
    fs::remove_dir(root.join(".mdbase")).unwrap();
    fs::create_dir(root.join("unrelated")).unwrap();
    symlink(root.join("unrelated"), root.join(".mdbase")).unwrap();
    assert!(write(&root).is_err());
    assert_eq!(fs::read_dir(root.join("unrelated")).unwrap().count(), 0);
}
