## Fixed

- Hosted sync no longer stops for good after a temporary server error, such as a busy database, a full account or a credential refreshed during a save. The change is retried, and devices already stuck this way resume on their next sync.
- Hosted sync changes that failed and were never retried are cleared after 30 days instead of being reported as unfinished work. Resending one later still applies it once.
