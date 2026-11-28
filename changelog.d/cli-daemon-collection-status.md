## Fixed

- CLI record and file commands can open a session while a collection is syncing.
- After an acknowledged collection deletion, the deleting computer immediately reports that sync has stopped and keeps the registered folder and its files.
- `mdbase device pending --json` now includes the same `approval_code` field as `mdbase status --json`. The legacy `sas` field remains available for existing scripts.
- Rejoining a collection with a revoked device identity now explains how to pair a new profile and preserve local edits.
