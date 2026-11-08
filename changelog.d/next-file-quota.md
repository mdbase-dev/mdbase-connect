## Changed

- Give each native collection a separate quota for uploaded files, set by the control plane through the new `set_file_headroom` log-service call. The storage quota now covers only notes, history and snapshots, so a collection whose files are full can still sync edits and deletions. Every collection keeps today's 1 GiB for each until plan limits are allocated.
