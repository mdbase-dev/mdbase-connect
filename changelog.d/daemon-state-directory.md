## Security

- The `mdbase` daemon log names collections by ID only: it no longer records the state directory, the control socket or a collection's folder, and a folder that cannot be opened because of a symlinked lock or host file is reported by its path inside the collection (for example `.mdbase/host.lock`).
