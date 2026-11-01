## Changed

- Hosted log appends no longer wait on the deletion registry. Each collection
  remembers its deletion floor; the registry fences a collection before
  recording its floor or Closing, so a write already in flight is refused, never
  published. Log compaction and garbage collection now archive to object
  storage without holding the collection's write lock.
