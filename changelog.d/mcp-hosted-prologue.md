## Fixed

- MCP tool calls to a cloud-copy collection's hosted replica now send the client prologue before the Noise handshake, as the hosted replica requires; the session was previously closed before it started.
- MCP tool calls on a cloud-copy collection now wait for the hosted replica to pick up a newly approved connection instead of failing in the first seconds after approval, and are run again when the replica closes the session while it catches up. A write that is run again keeps its mutation ID, so it is not applied twice.
- `create_record`, `update_record` and `rename_record` now return the confirmed record on collections served by a replica; they previously reported `invalid_operation_response` after a successful write.
