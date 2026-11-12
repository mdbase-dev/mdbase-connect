## Security

- The legacy hosted provider deletes a notification event, including its record path and frontmatter, as soon as it is delivered, and a database migration removes events that earlier builds had already delivered.
- The legacy hosted provider stores and logs notification runtime failures as a stage and error category instead of the runtime's message text, which could include record field names or values.
