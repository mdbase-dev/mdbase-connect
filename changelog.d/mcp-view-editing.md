## Added

- The mdbase view in Claude and other MCP App hosts now starts a record folded to its key properties, with **Show more** for the rest and the body, and marks what the model's update changed.
- Edit a record's text in the view and tick its task boxes; each save is one revision-checked `update_record`, and the model is told what changed.
- Sort query results by a column, change choices, switches, dates, numbers and text in the table, and make a new record of the results' type from the table.
- **Open in Editor** opens the collection or the record shown in the mdbase Editor, and **Full screen** shows the view over the conversation. `list_connections` now returns each collection's `editor_url`.
- The Editor opens the note named in a `#note=<path>` link once its collection starts.
