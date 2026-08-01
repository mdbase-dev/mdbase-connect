use crate::ConnectError;
use std::path::Path;

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
