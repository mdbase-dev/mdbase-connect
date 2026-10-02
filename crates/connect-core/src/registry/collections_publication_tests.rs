use super::*;

fn publication_fixture() -> (tempfile::TempDir, PathBuf, NamedTempFile) {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("mdbase.yaml");
    fs::write(&target, "name: Original\n").unwrap();
    let mut temporary = NamedTempFile::new_in(directory.path()).unwrap();
    temporary.write_all(b"name: Updated\n").unwrap();
    temporary.as_file().sync_all().unwrap();
    (directory, target, temporary)
}

#[test]
fn transient_windows_config_sharing_errors_preserve_atomic_publication() {
    for code in [5, 32, 33] {
        let (_directory, target, temporary) = publication_fixture();
        let source = temporary.path().to_owned();
        let mut attempts = 0;
        persist_config_with_windows_retry(temporary, |file| {
            attempts += 1;
            assert_eq!(file.path(), source);
            assert_eq!(fs::read_to_string(&target).unwrap(), "name: Original\n");
            if attempts < 3 {
                Err(tempfile::PersistError {
                    error: std::io::Error::from_raw_os_error(code),
                    file,
                })
            } else {
                file.persist(&target)
            }
        })
        .unwrap();
        assert_eq!(attempts, 3);
        assert_eq!(fs::read_to_string(&target).unwrap(), "name: Updated\n");
        assert!(!source.exists());
    }
}

#[test]
fn permanent_config_publication_errors_keep_the_destination_and_are_bounded() {
    for code in [5, 32, 33, 2] {
        let (_directory, target, temporary) = publication_fixture();
        let mut attempts = 0;
        let error = persist_config_with_windows_retry(temporary, |file| {
            attempts += 1;
            assert_eq!(fs::read_to_string(&target).unwrap(), "name: Original\n");
            Err(tempfile::PersistError {
                error: std::io::Error::from_raw_os_error(code),
                file,
            })
        })
        .unwrap_err();
        assert_eq!(attempts, if code == 2 { 1 } else { 21 });
        assert!(matches!(error, ConnectError::Io(error) if error.raw_os_error() == Some(code)));
        assert_eq!(fs::read_to_string(&target).unwrap(), "name: Original\n");
    }
}

#[cfg(windows)]
#[test]
fn native_config_replacement_retries_after_a_non_delete_shared_handle_is_released() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

    let (_directory, target, temporary) = publication_fixture();
    let mut blocker = Some(
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&target)
            .unwrap(),
    );
    let mut attempts = 0;
    persist_config_with_windows_retry(temporary, |file| {
        attempts += 1;
        let result = file.persist(&target);
        if blocker.is_some() {
            assert!(matches!(&result, Err(error) if matches!(error.error.raw_os_error(), Some(5 | 32 | 33))));
            // Release exactly after observing the native sharing failure, not
            // after a sleep or a guessed Windows timer tick.
            drop(blocker.take());
        }
        result
    }).unwrap();
    assert!(attempts >= 2);
    assert_eq!(fs::read_to_string(&target).unwrap(), "name: Updated\n");
}
