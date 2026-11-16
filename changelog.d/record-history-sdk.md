## Added

- Add `client.history` to the SDK (client API 1.4): `history.list(record, { before, limit })`
  pages a record's retained versions, newest first, with who wrote each one, and
  `history.version(record, seq)` reads one version's exact text. Restore a version by
  writing its text back with an ordinary update. Apps need the `collection.read`
  and `history.read` capabilities through a grant without a folder scope; a
  folder-scoped grant is refused with `forbidden` / `history_full_collection_required`.
  Only versions the replica applied are listed. A replica without history answers
  `upgrade_required` / `history_unsupported`, which `describeError` explains.
