## Fixed

- Stop directory mirrors from retrying a refused file upload, move or delete forever. A stale revision, an occupied path or an expired upload now makes the mirror plan again, a file over the size limit is set aside at once, and an object the authority refuses repeatedly for over an hour is set aside as a conflict. Other files keep syncing, and the set-aside file stays on disk for the user to resolve.
