## Added

- `mdbase conflicts dismiss <id> [collection]` accepts a record/file ID or unique prefix and dismisses its recorded merge conflicts using the replica's existing synced mutation. With multiple registered collections, specify the collection name or ID. Files stay unchanged; dismissal accepts the values already kept by the merge, not a local/remote side selection.
