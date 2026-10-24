//! Windows named pipe endpoints with an owner-only DACL.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::io;
use std::time::Duration;

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_BUSY, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::BoxStream;

/// The current process user's SID as `S-1-5-...`.
pub fn current_user_sid() -> io::Result<String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut len = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), len, &mut len);
        let err = io::Error::last_os_error();
        CloseHandle(token);
        if ok == 0 {
            return Err(err);
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut wide: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut wide) == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut n = 0usize;
        while *wide.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(wide, n));
        LocalFree(wide.cast());
        Ok(s)
    }
}

/// An owner-only security descriptor (`D:P(A;;GA;;;<SID>)`), freed on drop.
struct OwnerOnly {
    sd: PSECURITY_DESCRIPTOR,
}

impl OwnerOnly {
    fn new() -> io::Result<OwnerOnly> {
        let sid = current_user_sid()?;
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(OwnerOnly { sd })
    }

    fn create(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.sd,
            bInheritHandle: 0,
        };
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    name,
                    (&mut sa as *mut SECURITY_ATTRIBUTES).cast::<c_void>(),
                )
        }
    }
}

impl Drop for OwnerOnly {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.sd.cast());
        }
    }
}

// The descriptor is immutable after creation and only read by CreateNamedPipeW.
unsafe impl Send for OwnerOnly {}
unsafe impl Sync for OwnerOnly {}

pub(super) struct PipeListener {
    name: String,
    acl: OwnerOnly,
    next: NamedPipeServer,
}

impl PipeListener {
    pub(super) fn bind(name: &str) -> io::Result<PipeListener> {
        let acl = OwnerOnly::new()?;
        let next = acl.create(name, true)?;
        Ok(PipeListener {
            name: name.to_string(),
            acl,
            next,
        })
    }

    pub(super) async fn accept(&mut self) -> io::Result<BoxStream> {
        self.next.connect().await?;
        let fresh = self.acl.create(&self.name, false)?;
        let connected = std::mem::replace(&mut self.next, fresh);
        Ok(Box::new(connected))
    }

    pub(super) fn cleanup(&self) {}
}

pub(super) async fn connect(name: &str) -> io::Result<BoxStream> {
    for _ in 0..50 {
        match ClientOptions::new().open(name) {
            Ok(c) => return Ok(Box::new(c)),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::TimedOut, "pipe stayed busy"))
}
