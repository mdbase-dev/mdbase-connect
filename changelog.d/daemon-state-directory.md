## Security

- The `mdbase` daemon log names collections by ID only: it no longer records the state directory, the control socket or a collection's folder, and a folder that cannot be opened because of a symlinked lock or host file is reported by its path inside the collection (for example `.mdbase/host.lock`).
- The `mdbase` library, the Node package and the CLI's in-process commands keep a collection's index and identity only in a real default state directory: opening refuses `.mdbase` or `.mdbase/library` when it is a symlink or junction or, on Unix, owned by another user, and refuses a symlink inside `.mdbase/library`. A state directory passed explicitly is used as given.
