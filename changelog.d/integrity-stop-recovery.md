## Fixed

- Reopen a collection stopped by a failed sync consistency check automatically, retrying after 10 seconds, 1 minute, 5 minutes and then every 30 minutes, instead of leaving it stopped until the daemon restarts. `mdbase status` says when the next attempt is due, and `mdbase collection resume` (or Resume in the desktop app) retries at once. The daemon log now records the incident that stopped the collection.
