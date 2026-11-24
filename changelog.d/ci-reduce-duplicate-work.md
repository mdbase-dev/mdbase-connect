## Changed

- Narrowed `Server CI` pull-request qualification to a fast lane (`classify`, `node`, and only the heavy suites touched by the PR diff), keeping the full suite on `merge_group` and `ci:full` pull requests.
- Reused verified content-addressed `Runtime CI` results on `main` pushes when runtime inputs are unchanged, while preserving all required Worker qualification job names and success conclusions.
- Shared exact-tree `runtime-native-tests.yml` receipts between `Runtime CI` and `Server CI` so native runtime test shards run once per distinct Git tree instead of repeating across PR, merge queue, and `main` push.
