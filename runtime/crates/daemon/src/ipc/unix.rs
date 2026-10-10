//! Unix domain socket endpoints.

use std::io;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};

use super::BoxStream;

pub(super) struct UnixListener {
    inner: tokio::net::UnixListener,
    path: PathBuf,
}

impl UnixListener {
    pub(super) fn bind(path: &Path) -> io::Result<UnixListener> {
        let dir = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "socket path has no parent")
        })?;
        crate::fsutil::ensure_private_dir(dir)?;
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_socket() => std::fs::remove_file(path)?,
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("{} exists and is not a socket", path.display()),
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let inner = tokio::net::UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(UnixListener {
            inner,
            path: path.to_path_buf(),
        })
    }

    pub(super) async fn accept(&mut self) -> io::Result<BoxStream> {
        let (s, _) = self.inner.accept().await?;
        Ok(Box::new(s))
    }

    pub(super) fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub(super) async fn connect(path: &Path) -> io::Result<BoxStream> {
    Ok(Box::new(tokio::net::UnixStream::connect(path).await?))
}
