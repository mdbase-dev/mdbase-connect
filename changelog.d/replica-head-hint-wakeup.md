## Fixed

- Bring a stalled replica's next read forward when a pushed log head advances past the last probed head, at most once per 250 ms, instead of waiting out the 1-second backoff floor. Backoff is unchanged for no-news intervals, completed read replies and repeated non-advancing hints.
