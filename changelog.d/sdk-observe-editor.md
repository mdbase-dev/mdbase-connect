## Changed

- The editor uses SDK query observations instead of its separate collection
  load/watch, structural reconciliation and overlay workers. Asset opens use
  capability-gated `files.stat` before downloading a pinned revision. Record
  sessions, drafts, file inventory and presentation indexes remain app-owned.
  Newest-note startup uses a separate bounded query without ordering the live
  observer; stopped synchronization is shown explicitly with connection retry.
