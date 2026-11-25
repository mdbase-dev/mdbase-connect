## Added

- Runtime & SDK: indexed `file.mtime` ordering (ascending and descending, with
  ascending `file.path` tie-breaks) and keyset paging for `queryContract` and
  ordinary queries via the maintained `st_qmtime` query index, plus `file.mtime`
  exposure in query filters and selections.
- Protocol & SDK: gated `queryContract` `orderBy` on `file.mtime` behind the
  `contract-query-order-mtime-v1` `hello` feature so the SDK refuses with
  `upgrade_required` / `contract_query_order_mtime_unsupported` against older
  replicas instead of silently returning path order.
