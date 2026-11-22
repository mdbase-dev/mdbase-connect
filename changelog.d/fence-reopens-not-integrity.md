## Fixed

- A synced collection whose storage on this computer had a fault (for example a disk write that could not be confirmed) no longer stops as "Sync stopped after a consistency check failed" and refuses apps for up to 30 minutes. mdbase now shows it as opening, reopens it at once, and keeps no sync failure for it. The daemon log names the actual fault instead of `apply_reopen_required`.
- If the same storage fault comes back after 3 automatic reopens, mdbase stops retrying instead of reopening every 30 minutes. The collection shows as failed with a notice that names the fault and says to run `mdbase collection resume` (or choose Resume in the desktop app) once it is fixed. `mdbase doctor` reports it as a failure.
