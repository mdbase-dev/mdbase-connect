## Added

- `queryContract` (`query_contract_v1`) now accepts spec 11 `orderBy` terms
  (reusing the record query ordering grammar and semantics, bound to the cursor)
  and page sizes up to 1000 when the replica negotiates `contract-query-order-v1`.
  Older SDKs continue to work unchanged against new runtimes; new SDKs clamp
  page sizes to 128 and refuse `orderBy` with `upgrade_required` against older
  replicas.
- `executeAppBases` (`app_bases_execute_v1`) now accepts an optional
  `rowProperties` list of effective frontmatter property names (key 7) and
  returns each matched/windowed row's catalog `types` and requested effective
  `properties` (key 10) in the same read when the replica negotiates
  `bases-row-properties-v1`, eliminating per-row `get(id)` hydration without
  reading document bodies.
