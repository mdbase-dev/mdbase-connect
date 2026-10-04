## Changed

- A local collection whose folder a newer mdbase runtime has claimed is now
  reported as claimed instead of paused. Operations fail with
  `collection_claimed_by_newer_runtime`, whose message no longer includes the
  folder's absolute path; `collection list` shows `claimed`; `doctor` warns;
  the desktop app explains the move and offers removal; and the inventory sent
  to the server carries `unavailable_reason: "claimed_by_newer_runtime"`. The
  daemon stops polling the collection and releases its runtime instead of
  logging a warning every second, and the collection can now be removed from
  Connect. Invalid role-marker messages also no longer include absolute paths.
