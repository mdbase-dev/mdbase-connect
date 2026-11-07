## Fixed

- Hosted file uploads, moves and deletes no longer stop for good after a temporary server error, such as a busy database, a full account or an object storage outage. Retrying the same upload resumes it, and files already stuck this way go through on their next retry.
- Hosted file changes that failed and were never retried are cleared after 30 days instead of being reported as unfinished work. Resending one later still applies it once.
