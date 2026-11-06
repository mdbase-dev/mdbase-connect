## Fixed

- Refuse object garbage collection while a collection is being restored, because a restore imports objects before the items that reference them.
