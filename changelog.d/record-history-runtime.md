## Added

- Add record history to the device runtime: client API 1.4 `record_history` lists a record's versions from the retained log, newest first, with who wrote each one, and `record_version` returns one version's exact text. Both need the new `history.read` app capability, which Connect offers only to owners and editors. The hosted replica and local-only collections answer `history_unsupported`.
