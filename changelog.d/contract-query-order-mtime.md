## Added

- Runtime & SDK: indexed `file.mtime` ordering (ascending and descending, with
  ascending `file.path` tie-breaks), index-qualified `has(file.mtime)` and
  `!has(file.mtime)` predicates, and keyset paging (with tie-bucket path seeks)
  for `queryContract` and ordinary queries via the maintained `st_qmtime` query
  index, plus `file.mtime` exposure in query filters and selections
  (timestamp-valued projections and computed selections keep their native type
  in Core reductions, while direct `group_by` / `summaries` on `file.mtime`
  still fail Core compilation and the replica rejects whole-query reductions).
- Protocol & SDK: gated `queryContract` `orderBy` on `file.mtime` behind the
  `contract-query-order-mtime-v1` `hello` feature (advertised only by replicas
  whose store maintains the query index) so the SDK refuses with
  `upgrade_required` / `contract_query_order_mtime_unsupported` against older or
  non-indexed replicas instead of silently returning path order or refusing
  mid-pagination.
