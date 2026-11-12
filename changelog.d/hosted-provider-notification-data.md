## Security

- The legacy hosted provider deletes a notification event, including its record path and frontmatter, as soon as it is delivered, and its recovery sweep removes, in bounded batches, events that earlier builds had already delivered. No database migration is needed.
- The legacy hosted provider stores and logs notification runtime failures as a stage and error category instead of the runtime's message text, which could include record field names or values.
- Folder-scoped file access in the legacy hosted provider now compares paths with the same case and Unicode folding used for file identity, so a path's scope and identity always agree.
