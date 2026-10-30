## Added

- The `mdbase` CLI reads and writes records: `query`, `read`, `validate`, `types`, `create`, `update`, `delete`, `rename` and `batch`. A command goes through the daemon when it serves the folder, and otherwise opens the folder itself for that one command. `read --json` prints the revision for `--if-revision`, every write takes `--dry-run`, and `--json` failures carry a stable error code. `validate` with no paths checks every record in pages, so whole collections of any size validate (10,000 records in about a third of a second).
