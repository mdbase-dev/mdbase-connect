## Changed

- Joining a cloud copy on the next control plane now also returns the
  collection's log URL and its genesis item, so the joining device can verify
  and pin the genesis before it trusts the log.
- Enrolling a device in a private collection on the next control plane also
  returns the log URL and the genesis item, for the same reason.
