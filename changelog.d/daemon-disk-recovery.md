## Fixed

- The daemon retries collection opens after disk-full and other transient local I/O errors, with backoff capped at 30 minutes. Persistent sync integrity failures stop after three automatic reopens.
- Failed writes of sync diagnostics and host descriptors clean up their temporary files.
