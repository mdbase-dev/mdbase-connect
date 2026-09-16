//! Windows task definitions must scope the logon trigger as well as the
//! execution principal. An unscoped ONLOGON trigger requires administrator rights.

/// Scheduler chatter is not CLI output: in particular, `--json` callers parse
/// the entire stdout stream. Capture both pipes and retain diagnostics on error.
#[cfg(windows)]
pub(super) fn run(command: &mut std::process::Command, action: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = command
        .output()
        .map_err(|error| format!("Could not {action}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "Could not {action}: command exited with {}.\n{}\n{}",
        output.status.code().unwrap_or(-1),
        stderr.trim(),
        stdout.trim(),
    )
    .trim()
    .to_string())
}

pub(super) fn definition(executable: &str, state_dir: &str, sid: &str) -> Vec<u8> {
    // The Windows command-line parser consumes backslashes before a closing
    // quote. Preserve a root/trailing separator in the quoted state directory.
    let trailing_slashes = state_dir.chars().rev().take_while(|c| *c == '\\').count();
    let arguments = format!(
        "--state-dir \"{}{}\" connect daemon run",
        state_dir,
        "\\".repeat(trailing_slashes)
    );
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n\
         <Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">\n\
         <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>\n\
         <Principals><Principal id=\"Author\"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n\
         <Actions Context=\"Author\"><Exec><Command>{executable}</Command><Arguments>{arguments}</Arguments></Exec></Actions>\n\
         </Task>\n",
        sid = escape(sid),
        executable = escape(executable),
        arguments = escape(&arguments),
    );
    // schtasks loads task XML as a Unicode document, not an arbitrary UTF-8
    // file. Match its exported format: UTF-16LE with a byte-order mark.
    std::iter::once(0xfeff)
        .chain(document.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect()
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(windows)]
pub(super) fn current_user_sid() -> Result<String, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::{GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };

    let failure = || {
        format!(
            "Could not identify the current Windows account: {}",
            std::io::Error::last_os_error()
        )
    };
    let mut token = std::ptr::null_mut();
    // SAFETY: output is a valid HANDLE pointer; the process pseudo-handle is not
    // closed. The owned token below is closed once, including all error paths.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(failure());
    }
    // SAFETY: OpenProcessToken succeeded and transferred this real handle.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut size = 0;
    // SAFETY: null/zero buffer requests the required TokenUser buffer size.
    let sized = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut size,
        )
    };
    if sized != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER || size == 0 {
        return Err(failure());
    }
    // TOKEN_USER contains pointers, so byte-sized allocation is not sufficiently
    // aligned. Keep pointer alignment and round the requested byte count up.
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    // SAFETY: buffer is aligned for TOKEN_USER and has at least size bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(failure());
    }
    // SAFETY: the successful TokenUser query initialized this structure and SID.
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut text = std::ptr::null_mut();
    // SAFETY: user SID remains alive in buffer; conversion allocates a terminated
    // UTF-16 string released with LocalFree below, not CloseHandle.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(failure());
    }
    let sid = unsafe {
        let mut length = 0;
        while *text.add(length) != 0 {
            length += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(text, length));
        LocalFree(text.cast());
        result
    };
    sid.map_err(|_| "Windows returned an invalid account SID encoding.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn scheduler_errors_retain_exit_code_and_diagnostics() {
        let error = run(
            std::process::Command::new("cmd.exe").args([
                "/D",
                "/C",
                "echo task detail & echo Access is denied 1>&2 & exit /b 5",
            ]),
            "install the Connect background task",
        )
        .unwrap_err();
        assert!(error.contains("Could not install the Connect background task"));
        assert!(error.contains("command exited with 5"));
        assert!(error.contains("Access is denied"));
        assert!(error.contains("task detail"));
    }

    fn xml(executable: &str, state_dir: &str, sid: &str) -> String {
        let bytes = definition(executable, state_dir, sid);
        assert_eq!(&bytes[..2], &[0xff, 0xfe]);
        assert_eq!(bytes.len() % 2, 0);
        let units = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let document = String::from_utf16(&units).unwrap();
        assert!(document.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>"));
        document
    }

    #[test]
    fn logon_trigger_and_principal_name_the_same_user_without_elevation() {
        let sid = "S-1-5-21-123-456-789-1001";
        let xml = xml(r"C:\app\mdbase.exe", r"C:\state", sid);
        assert!(xml.contains(&format!("<UserId>{sid}</UserId></LogonTrigger>")));
        assert_eq!(xml.matches(&format!("<UserId>{sid}</UserId>")).count(), 2);
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(!xml.contains("HighestAvailable"));
    }

    #[test]
    fn xml_encodes_paths_and_separates_executable_from_arguments() {
        let xml = xml(
            r"C:\工具 & 🗒\mdbase.exe",
            r"C:\Users\O'Brien\notes & stuff",
            "S-1-5-21-1",
        );
        assert!(xml.contains(r"<Command>C:\工具 &amp; 🗒\mdbase.exe</Command>"));
        assert!(xml.contains(r"<Arguments>--state-dir &quot;C:\Users\O&apos;Brien\notes &amp; stuff&quot; connect daemon run</Arguments>"));
        assert_eq!(escape("<&>\"'"), "&lt;&amp;&gt;&quot;&apos;");
    }

    #[test]
    fn quoted_root_directory_preserves_its_final_backslash() {
        let xml = xml(r"C:\app\mdbase.exe", "C:\\", "S-1-5-21-1");
        assert!(xml.contains(r"--state-dir &quot;C:\\&quot; connect daemon run"));
    }
}
