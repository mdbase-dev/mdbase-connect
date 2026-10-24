//! Local IPC: owner-only stream endpoints and length-prefixed frames.
//!
//! - **Unix:** a domain socket in an owner-only (0700) directory, the socket
//!   itself 0600. A leftover socket file is removed only by the holder of the
//!   instance lock ([`crate::instance`]), so a running daemon's endpoint is never
//!   stolen.
//! - **Windows:** a named pipe whose DACL grants access to the current user's SID
//!   only (`replica-client-api.md` §12.2), created with
//!   `FILE_FLAG_FIRST_PIPE_INSTANCE` (a squatter makes startup fail rather than
//!   receive connections) and rejecting remote clients.
//!
//! Both endpoints carry byte streams. [`read_frame`]/[`write_frame`] add
//! `u32be(length) ‖ bytes` framing for the control protocol; the replica endpoint
//! carries Noise messages with `u16be` framing (SDK interface note §4).

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::paths::Endpoint;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
pub mod windows;

/// A connected local stream.
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// A boxed connected stream.
pub type BoxStream = Box<dyn Stream>;

/// A bound endpoint accepting connections.
pub struct Listener {
    #[cfg(unix)]
    inner: unix::UnixListener,
    #[cfg(windows)]
    inner: windows::PipeListener,
}

impl Listener {
    /// Bind `endpoint`. The caller must hold the instance lock.
    pub fn bind(endpoint: &Endpoint) -> io::Result<Listener> {
        #[cfg(unix)]
        {
            let Endpoint::Unix(path) = endpoint else {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "named pipes exist only on Windows",
                ));
            };
            Ok(Listener {
                inner: unix::UnixListener::bind(path)?,
            })
        }
        #[cfg(windows)]
        {
            let Endpoint::Pipe(name) = endpoint else {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Unix sockets are not used on Windows",
                ));
            };
            Ok(Listener {
                inner: windows::PipeListener::bind(name)?,
            })
        }
    }

    /// Wait for the next connection.
    pub async fn accept(&mut self) -> io::Result<BoxStream> {
        self.inner.accept().await
    }

    /// Remove the endpoint from the file system (Unix); no-op for pipes.
    pub fn cleanup(&self) {
        self.inner.cleanup();
    }
}

/// Connect to `endpoint`.
pub async fn connect(endpoint: &Endpoint) -> io::Result<BoxStream> {
    #[cfg(unix)]
    {
        let Endpoint::Unix(path) = endpoint else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "named pipes exist only on Windows",
            ));
        };
        unix::connect(path).await
    }
    #[cfg(windows)]
    {
        let Endpoint::Pipe(name) = endpoint else {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Unix sockets are not used on Windows",
            ));
        };
        windows::connect(name).await
    }
}

/// Largest control frame (1 MiB).
pub const MAX_CONTROL_FRAME: usize = 1 << 20;

/// Read one `u32be(length) ‖ bytes` frame. `Ok(None)` on a clean end of stream
/// before the length.
pub async fn read_frame<R: AsyncRead + Unpin + ?Sized>(
    r: &mut R,
    max: usize,
) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(len) as usize;
    if n > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame of {n} bytes exceeds {max}"),
        ));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// Write one `u32be(length) ‖ bytes` frame and flush.
pub async fn write_frame<W: AsyncWrite + Unpin + ?Sized>(
    w: &mut W,
    bytes: &[u8],
) -> io::Result<()> {
    let n = u32::try_from(bytes.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    let mut buf = Vec::with_capacity(4 + bytes.len());
    buf.extend_from_slice(&n.to_be_bytes());
    buf.extend_from_slice(bytes);
    w.write_all(&buf).await?;
    w.flush().await
}
