## Fixed

- Sync now resumes on its own after storage frees up. Clients retry writes the server refused for storage every minute and refused files every 10 minutes, and "Out of storage" clears once a write is accepted, instead of needing a restart.
