## Fixed

- Notify joined computers when a collection is deleted through the collection deletion API, stop syncing while preserving local files, and explain deletion in the desktop app, CLI, and open application sessions. Prompt notification requires the updated Cloudflare log-service Worker; reconnects and token refusals also detect deletion.
- Report deleted collections consistently in the runtime SDK as `forbidden` with reason `collection_deleted` and recovery `none`, and preserve that error on later operations. `collectionUnavailableError("collection_deleted")` previously returned `not_found`.
