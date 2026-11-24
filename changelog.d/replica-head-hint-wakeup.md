## Fixed

- Wake stalled replica reads immediately when a pushed log head advances past the last probed head instead of waiting out the 1-second backoff floor, while preserving backoff for no-news intervals, completed read replies, and repeated non-advancing hints.
