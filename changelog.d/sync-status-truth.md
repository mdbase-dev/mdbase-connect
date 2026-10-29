## Fixed

- Count unfinished file transfers and ingest work in daemon status, and wait for downloads before reporting a synced collection ready.
- Show collection connection outages in the desktop connection indicator and explain when the server's time disagrees with the system clock.
- Keep status and control commands responsive during bulk ingest and avoid scanning the pending queue for every published record.
