use super::{file_error, open_verified_file, sync_parent, verify_open_path};
use crate::ConnectError;
use std::fs::OpenOptions;
use std::path::Path;

pub(super) fn create_or_recover_private_staging_file(path: &Path) -> Result<bool, ConnectError> {
    match OpenOptions::new().create_new(true).write(true).open(path) {
        Ok(file) => {
            set_owner_only_file(path)?;
            file.sync_all()?;
            sync_parent(path)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = std::fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != 0 {
                return Err(file_error(
                    "staging_file_invalid",
                    "An orphan upload staging path is unsafe or contains data.",
                ));
            }
            let file = open_verified_file(path, true)?;
            set_owner_only_file(path)?;
            file.sync_all()?;
            verify_open_path(&file, path)?;
            sync_parent(path)?;
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn create_private_staging_file(path: &Path) -> Result<(), ConnectError> {
    let file = OpenOptions::new().create_new(true).write(true).open(path)?;
    set_owner_only_file(path)?;
    file.sync_all()?;
    sync_parent(path)
}

#[cfg(unix)]
pub(super) fn set_owner_only_directory(path: &Path) -> Result<(), ConnectError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn set_owner_only_directory(_path: &Path) -> Result<(), ConnectError> {
    Ok(())
}

#[cfg(unix)]
pub(super) fn set_owner_only_file(path: &Path) -> Result<(), ConnectError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn set_owner_only_file(_path: &Path) -> Result<(), ConnectError> {
    Ok(())
}
